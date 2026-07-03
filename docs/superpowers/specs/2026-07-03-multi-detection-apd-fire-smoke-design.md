# Design: Settings Simplification + Multi-Detection (APD / Fire / Smoke)

Status: approved by user (2026-07-03), ready for implementation planning.

## Context

The system currently does one thing per camera: person counting (line-crossing or
zone) via a single Triton-served YOLO model. This design adds two independent
pieces of work:

- **Part A** — small UX cleanup: remove per-camera MQTT topic fields from the
  Add Camera dialog (defaults come from global settings instead, editable later),
  and relocate the `DETECTION_MODE` control from the Line Configuration tab to
  Basic Settings as a dropdown.
- **Part B** — a new capability: a camera can *additionally* run APD (PPE
  violation) detection and/or Fire & Smoke detection, on top of its existing
  person-counting pipeline, each with its own Triton model, and emit tagged
  (`info`/`alarm`) events distinguished by a `type` field over MQTT and into a
  new Postgres table.

Both parts touch the same device settings page, so they're speced together, but
they have no code dependency on each other and can be implemented/rolled out in
either order.

## Part A — Settings Simplification

### Add Camera dialog
Remove the Activity Topic and Interval Topic input fields entirely from the
create-camera form (`dashboard/app/devices/page.tsx` create dialog). On create,
`MQTT_TOPIC` and `MQTT_INTERVAL_TOPIC` are derived from new global setting
templates with `{code}` substituted for the device code:

- `mqtt.activityTopicTemplate` default `/person_in/{code}`
- `mqtt.intervalTopicTemplate` default `/resampling_person/{code}`

These become part of `GlobalSettings.mqtt` (`dashboard/lib/types.ts`) and are
editable in the Settings page (new inputs alongside broker/port/username/password).
Existing per-device values are untouched — the template only applies at device
creation time. Editing a device's actual topics after creation still happens on
the device detail page (Basic Settings tab), unchanged.

### Detection Mode relocation
Move the `DETECTION_MODE` control (`app/devices/[code]/page.tsx`) from the "Line
Configuration" tab to "Basic Settings", converting it from the current button-group
to a `<Select>` (`line_crossing` | `zone`), matching the existing Screen Resolution
dropdown pattern. The Line Configuration tab keeps only the line/zone drawing UI,
which already conditionally renders based on `DETECTION_MODE`.

## Part B — Multi-Detection System

### Pipeline architecture

One camera container can run up to three detectors per frame: the existing
person/counting model (always on), and two new optional ones. Each optional
detector is independently toggled per device:

```
frame → [Triton: person model]      → ByteTrack (existing)      → counting (unchanged: person_inout/inout_resample)
      → [Triton: APD model]         → ByteTrack (2nd instance)   → per-track violation dedup → detection_events + MQTT
      → [Triton: fire/smoke model]  → no tracker                 → per-class cooldown        → detection_events + MQTT
```

All three Triton calls happen sequentially in the same frame loop, reusing
`inference.TritonYoloClient` (one instance per active detector, each pointed at
its own `TRITON_MODEL`). Triton's own dynamic batching still applies across
cameras; per-camera latency scales with however many detectors are enabled
(up to 3x one-model latency). This is an accepted trade-off for this iteration —
not a blocker, and parallelizing the calls is a future option if latency becomes
an issue.

Model provisioning reuses 100% of the existing export/build infra
(`tools/export_model.py`, `triton-model-builder`) — APD and fire/smoke models are
just additional entries in the `models/` repository, no new tooling needed.
Model files themselves are out of scope for this round (fields are wired up;
actual trained weights are supplied later).

### APD detection logic

- Runs its own `BYTETracker` instance (separate from the person-counting tracker;
  different model, different classes, independent lifecycle).
- Dedup is **per track_id, not per frame**: the first time a track is seen with a
  violation class (e.g. `no_helmet`), fire one event. While that same track_id
  persists, do not re-fire for the same label. No expiry logic needed — tracker
  churn naturally recycles IDs, matching the simplicity of the existing
  line-crossing state dicts.
- `class_id` filter is not fixed to person (0) — APD models define their own
  class list; whatever `model.names` reports becomes the `label` field.

### Fire/Smoke detection logic

- No tracker. Any frame where the model detects `fire` or `smoke` (above
  `FIRE_SMOKE_CONFIDENCE`) is a candidate event.
- **Cooldown per (device, label)**: after firing for a label, suppress further
  fires for that label until `FIRE_SMOKE_COOLDOWN_MINUTES` has elapsed — same
  pattern as the existing `MQTT_INTERVAL_MINUTES` interval-send guard
  (`outputs/mqtt_out.py`'s `should_send_interval_mqtt`).
- One model may report both `fire` and `smoke` classes (2-class model) or two
  separate models could be configured — the design doesn't require them to be
  the same model, but the UI treats "Fire & Smoke Detection" as a single
  toggle/model/confidence group with two independent tag fields (`FIRE_TAG`,
  `SMOKE_TAG`), since tag is scoped per detection *type*, not per model.

### Tagging and output type

Every emitted event (all four types: `people_counting`, `apd`, `fire`, `smoke`)
carries:
- `type`: one of `people_counting` | `apd` | `fire` | `smoke`
- `tag`: `info` | `alarm`, independently configurable per device per type

`tag` defaults: `people_counting` → `info`, `apd` → `alarm`, `fire` → `alarm`,
`smoke` → `alarm` — but all are user-overridable per device (per earlier
decision: fully configurable per device, per detection type).

The existing `send_person_in_mqtt` payload (`outputs/mqtt_out.py`) gains `"type":
"people_counting"` and `"tag": <PEOPLE_COUNTING_TAG>` fields. No topic change —
per user decision, all types publish to the existing `MQTT_TOPIC` for that
device; consumers distinguish by the `type` field in the JSON payload.

**Image payload**: APD events include a base64 JPEG crop of the violating
track's bounding box, reusing the existing `crop_image()` helper — mirrors how
person_in/person_out events already work. Fire/smoke events have no single
bounding subject, so they include the full current frame instead of a crop.

### Database schema

`person_inout` and `inout_resample` are untouched — they keep serving cumulative
in/out counters exactly as today. A new table captures discrete APD/fire/smoke
events only:

```sql
CREATE TABLE IF NOT EXISTS detection_events (
    id UUID PRIMARY KEY,
    device_id UUID NOT NULL,
    device_code TEXT NOT NULL,
    device_name TEXT,
    detection_type TEXT NOT NULL CHECK (detection_type IN ('apd', 'fire', 'smoke')),
    tag TEXT NOT NULL CHECK (tag IN ('info', 'alarm')),
    label TEXT NOT NULL,        -- raw class name from the model, e.g. 'no_helmet'
    track_id INTEGER,           -- null for fire/smoke (no tracker)
    confidence REAL NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_detection_events_device_time
    ON detection_events (device_id, created_at DESC);
```

### `init_db.py`

New standalone script (`python-counting/init_db.py`) that connects using the
same `PG_*` env vars as the main service and issues `CREATE TABLE IF NOT
EXISTS` for all three tables: `person_inout`, `inout_resample`, and
`detection_events` (plus their indexes/constraints). Safe to run repeatedly;
intended as the one-stop way to provision a fresh database, and also
self-documents the full schema in one place (today it's implicit/undocumented
outside the README).

### Environment variables (new, per device)

| Var | Default | Purpose |
|---|---|---|
| `APD_ENABLED` | `false` | toggle APD detector |
| `APD_MODEL` | — | Triton model name |
| `APD_CONFIDENCE` | `0.3` | detection threshold |
| `APD_TAG` | `alarm` | tag for apd events |
| `FIRE_SMOKE_ENABLED` | `false` | toggle fire/smoke detector |
| `FIRE_SMOKE_MODEL` | — | Triton model name |
| `FIRE_SMOKE_CONFIDENCE` | `0.3` | detection threshold |
| `FIRE_TAG` | `alarm` | tag for fire events |
| `SMOKE_TAG` | `alarm` | tag for smoke events |
| `FIRE_SMOKE_COOLDOWN_MINUTES` | `5` | re-alert suppression window per label |
| `PEOPLE_COUNTING_TAG` | `info` | tag attached to existing person_in/out MQTT payload |

### Dashboard UI

- **Device detail page**: new "Additional Detection" section (Basic Settings tab,
  below the existing YOLO/Triton model block) with two collapsible groups:
  - APD Detection: toggle, model dropdown (populated from `/api/triton/models`,
    same pattern as the existing Triton Model dropdown), confidence input, tag
    dropdown (info/alarm).
  - Fire & Smoke Detection: toggle, model dropdown, confidence input, two tag
    dropdowns (Fire Tag, Smoke Tag), cooldown minutes input.
- **Settings page**: new MQTT topic template fields (Part A) and defaults for
  the new per-device env vars (`APD_CONFIDENCE`, `FIRE_SMOKE_CONFIDENCE`,
  `FIRE_SMOKE_COOLDOWN_MINUTES`, and the four default tags) under Detection
  Defaults, applied when a new device is created (same mechanism as existing
  `yolo_confidence` default).
- **Annotated MJPEG stream**: draw APD violation boxes and fire/smoke detection
  boxes in distinct colors (e.g. orange for APD, red for fire, gray for smoke),
  reusing the existing overlay-drawing code path in `main.py`.

## Testing

- Unit-level: cooldown timer logic (fire/smoke) and per-track dedup logic (APD)
  get the same kind of test treatment as the existing parity suite — pure
  functions/state machines, testable without a live Triton connection.
- `init_db.py` tested against a scratch Postgres/Timescale instance (or the
  playground server's `env_services_timescaledb`) to confirm idempotent
  `CREATE TABLE IF NOT EXISTS` behavior.
- End-to-end: since no APD/fire/smoke model weights exist yet, full pipeline
  validation is blocked until a model is supplied — the implementation plan
  should make this dependency explicit and test what it can (config wiring,
  event dedup/cooldown logic with a stub/mock Triton response) without it.
