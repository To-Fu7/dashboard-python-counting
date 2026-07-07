# Design: Hourly Aggregates, Face Detection, Per-Type MQTT Topics

Status: approved by user (2026-07-07), ready for implementation planning.

## Context

Three related but independently-shippable changes on top of the existing Triton
multi-detection system (person counting + APD + fire/smoke, already in
production on `feat/triton-migration`):

- **Part A** — replace per-event DB rows with **hourly aggregate rows,
  upserted in place**, for person counting (already partially this way via
  `inout_resample`) and for APD/fire-smoke (currently per-event rows in
  `detection_events`, added in the previous round). Pre-generate a full day's
  24 hourly rows up front so consumers always see a complete day, backfilled
  with zeros for hours not yet reached.
- **Part B** — a new **face detection** subsystem: detect faces, embed them,
  match against an enrolled roster in Postgres, and label each detected
  person `insider` (matched name) or `intruder` (no match). Replaces the
  existing standalone `face-comparison.py` (MTCNN + FaceNet, its own FastAPI
  service) with Triton-served models, matching the architecture already
  established for APD/fire-smoke.
- **Part C** — give APD, fire/smoke, and face their **own configurable MQTT
  topics** per device (currently all three publish to the same `MQTT_TOPIC`
  as person-counting events, distinguished only by a `type` field).

**Design-wide constraint:** minimize CPU/RAM on the edge device; push
inference load onto the GPU via Triton. This is the same principle the
original Triton migration was built around — every new per-frame cost added
here should be justified against it.

## Part A — Hourly Aggregates

### Schema

Three new tables, one per detection type, replacing `detection_events`
(dropped entirely from `init_db.py` — this system has no external consumers
yet, so no migration path is needed):

```sql
CREATE TABLE apd_hourly (
    device_id UUID NOT NULL,
    device_code TEXT NOT NULL,
    device_name TEXT,
    hour_start TIMESTAMPTZ NOT NULL,
    data JSONB NOT NULL DEFAULT '{}',   -- {"NO-Hardhat": 10, "NO-Mask": 3, "unique_persons": 8}
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (device_id, hour_start)
);
-- firesmoke_hourly: same shape, data = {"fire": 3, "smoke": 7}
-- face_hourly:      same shape, data = {"<name>": N, ..., "intruder": M, "unique_persons": K}
```

`inout_resample` (existing) keeps its current columns; only its *lifecycle*
changes (see below) — no schema change needed there.

### Pre-generation / backfill

On service startup, and whenever the local day rolls over, the service
upserts (`ON CONFLICT (device_id, hour_start) DO NOTHING`) all 24 hourly rows
for the current day for every table whose detection type is enabled on that
device (`inout_resample` always, `apd_hourly` only if `APD_ENABLED`,
`firesmoke_hourly` only if `FIRE_SMOKE_ENABLED`, `face_hourly` only if
`FACE_ENABLED`). Hours already past get `data: {}` (reads as zero downstream)
until an event fills them in; this is intentionally a one-shot bulk insert
(24 rows, once a day) — cheap, not a per-frame cost.

If a detection type is enabled mid-day (operator flips `APD_ENABLED` on at
14:00), the same pre-generation routine runs immediately for that type,
covering `00:00`–current hour with zero-value placeholders, so the day's row
set is always complete regardless of when the feature was turned on.

### Event write path

Each detection module (`apd.py`, `firesmoke.py`, and the new `face.py`)
replaces `insert_detection_event(...)` with an **upsert-increment** helper,
`increment_hourly(table, device_id, hour_start, label)`, parameterized so the
dynamic JSON key is always a bound parameter, never string-interpolated:

```sql
INSERT INTO apd_hourly (device_id, device_code, device_name, hour_start, data)
VALUES (%(device_id)s, %(device_code)s, %(device_name)s, %(hour_start)s,
        jsonb_build_object(%(label)s, 1))
ON CONFLICT (device_id, hour_start) DO UPDATE
SET data = jsonb_set(
        apd_hourly.data,
        array[%(label)s],
        to_jsonb(COALESCE((apd_hourly.data ->> %(label)s)::int, 0) + 1)
    ),
    updated_at = now()
```

(table name is the one static, code-controlled part — chosen by which
detector module calls the helper, never derived from event data). `label`
is always the bound `%(label)s` parameter, so a label value can't inject SQL
or an arbitrary JSON path. `unique_persons` is incremented with the same
helper, called once per track_id per hour (first time that key is seen in
that hour) rather than once per event — reusing the existing per-track dedup
state (`state.apd_alerted_tracks`, and the new `state.face_alerted_tracks`)
to know whether a track has already been counted this hour.

This still goes through the existing async fire-and-forget `db_queue_write`
— no new DB connection pattern, no added per-frame cost (the write only
happens on a dedup'd/cooldown'd event, exactly as before).

## Part B — Face Detection

### Pipeline

```
frame → [Triton: YOLOv8-face]  → ByteTrack (own instance) → per-track dedup (once per track_id)
      → crop face region       → [Triton: ArcFace]         → 512-d embedding
      → cosine similarity vs in-memory known_faces cache
      → match >= threshold → label = matched person_name, tag = info
      → no match            → label = "intruder",          tag = alarm
      → apd_hourly-style upsert into face_hourly + MQTT publish (own topic, Part C)
```

Face detection is a **separate device/toggle** (`FACE_ENABLED`), independent
of person-counting and APD — it runs its own YOLOv8-face inference on
`detection_frame` (the same crop region already used by the other detectors)
rather than reusing person-counting's boxes, per the earlier decision. This
means a face-only device doesn't need person-counting enabled at all.

### Models

- **Detection: YOLOv8-face.** A YOLO model fine-tuned on WIDERFACE (single
  class: face). Exported via the *existing, unmodified* `tools/export_model.py`
  — no new export tooling needed, identical to how APD/fire-smoke models are
  provisioned.
- **Embedding: ArcFace.** A single CNN forward pass over the cropped,
  aligned face producing a 512-d embedding, exported to ONNX the same way.
  Replaces `facenet-pytorch`'s InceptionResnetV1 (used by the existing
  standalone `face-comparison.py`, which is not modified or wired in —
  it stays as reference/legacy, unused by the new pipeline).
- Both models run on Triton (GPU), matching the "minimize edge CPU/RAM" constraint
  — the camera container only does letterbox preprocessing (already the
  established pattern) and a cosine-similarity comparison against a small
  in-memory float array cache (cheap, CPU-side, negligible relative to
  video decode).

### `known_faces` table and enrollment

```sql
CREATE TABLE known_faces (
    id UUID PRIMARY KEY,
    person_name TEXT NOT NULL,
    embedding REAL[] NOT NULL,       -- 512 floats, plain array (no pgvector dependency)
    source_photo_path TEXT,          -- where the original upload is stored
    variant_type TEXT NOT NULL,      -- 'original' | 'skew' | 'contrast' | 'flip'
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_known_faces_person ON known_faces (person_name);
```

One person has **multiple rows**, one per augmented variant — matching
compares an incoming embedding against every stored row and takes the best
cosine similarity, not an average.

**Enrollment flow (dashboard):** new page/section — admin uploads a photo +
name. The Next.js API server-side: generates augmented variants (skew,
contrast up/down, horizontal flip) from the uploaded image, sends each
variant to Triton's ArcFace model directly (dashboard calls Triton the same
way it already calls it for model listing — a new small HTTP/gRPC client
call, not a new service), and inserts one `known_faces` row per variant with
the resulting embedding. The face detection step (YOLOv8-face) does **not**
need to run during enrollment if the uploaded photo is already a
tightly-cropped face; if it's a fuller photo, the same YOLOv8-face model
detects and crops the face first, then ArcFace embeds it — same two-model
pipeline as runtime detection, just invoked once at upload time instead of
per-frame.

### In-memory cache + refresh

Each camera container with `FACE_ENABLED=true` loads the full `known_faces`
table into memory at startup and **refreshes every 10 minutes** on a
background timer (not per-frame, not per-detection) — bounded, predictable
DB load, and a known worst-case staleness window (new enrollments take up to
10 minutes to reach a running camera). The cache is a flat list of
`(person_name, embedding: np.ndarray)`; matching is a single vectorized
cosine-similarity computation against the whole cache per detected face —
cheap even with a few hundred enrolled variants.

### Dedup

A new `state.face_alerted_tracks` (mirrors `apd_alerted_tracks`): dict of
`track_id -> label already alerted this track's lifetime`. A track fires
exactly one event (insider-with-name or intruder) the first time it's
classified, not on every frame it's visible — same "first-seen" pattern as
APD, reusing the same tracker-reset-on-Triton-reconnect wiring already built
for APD (`reset_tracking_state`/`reset_apd_state` extends to a third
`reset_face_state`).

## Part C — Per-Type MQTT Topics

New per-device env vars, each with a default derived from the existing base
topic, editable individually (same pattern as `MQTT_TOPIC`/
`MQTT_INTERVAL_TOPIC` today):

| Var | Default |
|---|---|
| `MQTT_APD_TOPIC` | `{MQTT_TOPIC}/apd` |
| `MQTT_FIRESMOKE_TOPIC` | `{MQTT_TOPIC}/firesmoke` |
| `MQTT_FACE_TOPIC` | `{MQTT_TOPIC}/face` |

`send_detection_event_mqtt` (in `outputs/mqtt_out.py`) gains a `topic`
parameter (currently hardcoded to `cfg.MQTT_TOPIC`); each detector module
passes its own resolved topic. Person-counting's `send_person_in_mqtt` is
unaffected — it keeps publishing to `MQTT_TOPIC`/`MQTT_INTERVAL_TOPIC` as
today.

Dashboard: three new fields on the device detail page (Basic Settings →
MQTT Topics section, alongside the existing two), each pre-filled with the
derived default at device-creation time (same `{code}`-style templating
mechanism used for the existing topic defaults), editable per device
afterward.

## Testing

- Part A: unit tests for the upsert-increment query logic and the
  pre-generation/backfill routine (24-row generation, partial-day backfill
  when a type is enabled mid-day), following the existing
  `tests/testutil.py` plain-script pattern — no live DB required, mock
  `db_queue_write` the same way `test_detection_events.py` already does.
- Part B: unit tests for the cosine-similarity matching logic and the
  per-track dedup state machine (mirrors the existing
  `test_detection_events.py` APD dedup tests), with a small fixture set of
  fake embeddings — no real YOLOv8-face/ArcFace model needed for this level
  of test (matches how APD/fire-smoke were tested: pure logic, Triton calls
  mocked).
- Part C: no new logic to unit-test beyond confirming the topic
  default-derivation function; covered by the same live-dev-server
  verification pattern used for previous device-creation defaults (create a
  test device via the API, confirm derived topics land in `.env_<code>`).
- End-to-end validation of the actual YOLOv8-face/ArcFace models is blocked
  on sourcing/training those weights (same acknowledged gap as APD/fire-smoke
  before their models were found) — this plan wires up the capability;
  real model acquisition is a separate follow-up step, same pattern as before.
