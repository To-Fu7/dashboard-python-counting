# Multi-Detection (APD / Fire / Smoke) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a camera additionally run APD (PPE violation) and/or Fire & Smoke detection alongside its existing person-counting pipeline, each with its own Triton model, emitting tagged (`info`/`alarm`) events distinguished by a `type` field over MQTT and into a new `detection_events` Postgres table.

**Architecture:** Two new optional Triton-backed detectors run per frame in `main.py`, independent of the always-on person/counting pipeline. APD gets its own `BYTETracker` instance and dedups per (track_id, label) for the life of the track. Fire/Smoke has no tracker and instead uses a per-label cooldown timer. Both write to a new `detection_events` table (async, via the existing DB worker queue) and publish to the existing `MQTT_TOPIC` with a `type`/`tag` field added to the JSON payload. Class-id → label resolution reads `metadata.json` from the shared `models/` repository (already bind-mounted into every camera container).

**Tech Stack:** Python 3.11 (python-counting thin client), `tritonclient[grpc]`, `psycopg2`, `paho-mqtt`; Next.js/TypeScript (dashboard).

**Spec:** `docs/superpowers/specs/2026-07-03-multi-detection-apd-fire-smoke-design.md` (Part B)

**Prerequisite:** None strictly required — `docs/superpowers/plans/2026-07-03-settings-simplification.md` touches a different region of `dashboard/app/devices/[code]/page.tsx` (the Video section and the Line Configuration tab) than this plan's Task 16 (which anchors after "Detection Model (Triton)" and before the Save button, untouched by that plan). Either plan can be applied first. Recommended order: settings-simplification first, since it's smaller and lower-risk.

---

## Part 1 — python-counting

### Task 1: Database schema — `init_db.py`

**Files:**
- Create: `python-counting/init_db.py`

- [ ] **Step 1: Write the schema provisioning script**

```python
"""One-stop database provisioning: creates person_inout, inout_resample, and
detection_events if they don't already exist. Safe to run repeatedly.

Usage:  python init_db.py
Reads the same PG_* environment variables as main.py (via a .env file or the
process environment).
"""
import logging
import os

import psycopg2
from dotenv import load_dotenv

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

load_dotenv('.env')

PG_HOST = os.getenv('PG_HOST')
PG_PORT = int(os.getenv('PG_PORT', 5432))
PG_DB = os.getenv('PG_DB')
PG_USER = os.getenv('PG_USER')
PG_PASS = os.getenv('PG_PASS')

SCHEMA_STATEMENTS = [
    """
    CREATE TABLE IF NOT EXISTS person_inout (
        id UUID PRIMARY KEY,
        device_id UUID NOT NULL,
        total_in INTEGER NOT NULL DEFAULT 0,
        total_out INTEGER NOT NULL DEFAULT 0,
        data JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_person_inout_device_time ON person_inout (device_id, created_at DESC)",
    """
    CREATE TABLE IF NOT EXISTS inout_resample (
        id SERIAL PRIMARY KEY,
        device_id UUID NOT NULL,
        device_name TEXT,
        device_code TEXT,
        interval_in INTEGER NOT NULL DEFAULT 0,
        interval_out INTEGER NOT NULL DEFAULT 0,
        hour_start TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (device_id, hour_start)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS detection_events (
        id UUID PRIMARY KEY,
        device_id UUID NOT NULL,
        device_code TEXT NOT NULL,
        device_name TEXT,
        detection_type TEXT NOT NULL CHECK (detection_type IN ('apd', 'fire', 'smoke')),
        tag TEXT NOT NULL CHECK (tag IN ('info', 'alarm')),
        label TEXT NOT NULL,
        track_id INTEGER,
        confidence REAL NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_detection_events_device_time ON detection_events (device_id, created_at DESC)",
]


def main():
    logging.info(f"Connecting to {PG_HOST}:{PG_PORT}/{PG_DB} as {PG_USER}...")
    conn = psycopg2.connect(dbname=PG_DB, user=PG_USER, password=PG_PASS, host=PG_HOST, port=PG_PORT)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            for stmt in SCHEMA_STATEMENTS:
                cur.execute(stmt)
                logging.info(f"OK: {stmt.strip().splitlines()[0].strip()}")
        logging.info("Schema is up to date (person_inout, inout_resample, detection_events).")
    finally:
        conn.close()


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Run it against a real (or scratch) Postgres instance**

Run: `cd python-counting && python init_db.py` (with `.env` or `PG_*` env vars pointing at a reachable Postgres/TimescaleDB)
Expected output ends with: `Schema is up to date (person_inout, inout_resample, detection_events).`

- [ ] **Step 3: Verify idempotency**

Run the same command again: `python init_db.py`
Expected: same success output, no errors (all statements use `IF NOT EXISTS`).

- [ ] **Step 4: Commit**

```bash
git add python-counting/init_db.py
git commit -m "Add init_db.py to provision person_inout, inout_resample, detection_events"
```

---

### Task 2: Port `crop_image()` and fix the person-event image bug

The legacy pipeline cropped a padded box around the person before sending it via
MQTT (`crop_image()` in the old single-file `main.py`). That helper was never
carried over during the Triton migration — `counting.py`'s `_count_in`/`_count_out`
currently send the **full frame**, not a crop. This task ports the helper and
fixes the two call sites; APD events (Task 7) will reuse the same helper.

**Files:**
- Create: `python-counting/outputs/image_utils.py`
- Modify: `python-counting/counting.py:13-16` (imports)
- Modify: `python-counting/counting.py:72-107` (`_count_in`/`_count_out` signatures + bodies)
- Modify: `python-counting/counting.py:162-199` (call sites, 4 total)

- [ ] **Step 1: Create the cropping helper**

```python
"""Cropping helper for MQTT event images — ported from the legacy main.py
(crop_image), which was dropped during the Triton migration. Used by the
person-counting line-crossing events (counting.py) and APD violation events
(detection/apd.py).
"""
import cv2

import counting_config as cfg


def crop_image(frame, box, padding=None):
    """Crop image around a detection box with padding, upscaling if too small.

    box: (x1, y1, x2, y2) in the frame's own coordinate system.
    """
    if padding is None:
        padding = cfg.CROP_PADDING

    x1, y1, x2, y2 = box
    h, w = frame.shape[:2]

    x1_crop = max(0, x1 - padding)
    y1_crop = max(0, y1 - padding)
    x2_crop = min(w, x2 + padding)
    y2_crop = min(h, y2 + padding)

    person_crop = frame[y1_crop:y2_crop, x1_crop:x2_crop]

    crop_h, crop_w = person_crop.shape[:2]
    if crop_h < cfg.MIN_CROP_SIZE[1] or crop_w < cfg.MIN_CROP_SIZE[0]:
        aspect_ratio = crop_w / crop_h
        if aspect_ratio > 1:
            new_w = max(cfg.MIN_CROP_SIZE[0], crop_w)
            new_h = int(new_w / aspect_ratio)
            if new_h < cfg.MIN_CROP_SIZE[1]:
                new_h = cfg.MIN_CROP_SIZE[1]
                new_w = int(new_h * aspect_ratio)
        else:
            new_h = max(cfg.MIN_CROP_SIZE[1], crop_h)
            new_w = int(new_h * aspect_ratio)
            if new_w < cfg.MIN_CROP_SIZE[0]:
                new_w = cfg.MIN_CROP_SIZE[0]
                new_h = int(new_w / aspect_ratio)
        person_crop = cv2.resize(person_crop, (new_w, new_h), interpolation=cv2.INTER_LANCZOS4)

    return person_crop
```

- [ ] **Step 2: Wire it into `counting.py`'s imports**

In `python-counting/counting.py`, replace:
```python
import app_state as state
import counting_config as cfg
from outputs.db_worker import db_queue_write
from outputs.mqtt_out import send_person_in_mqtt
```
with:
```python
import app_state as state
import counting_config as cfg
from outputs.db_worker import db_queue_write
from outputs.image_utils import crop_image
from outputs.mqtt_out import send_person_in_mqtt
```

- [ ] **Step 3: Add a `box` parameter to `_count_in`/`_count_out` and crop before sending**

Replace:
```python
def _count_in(track_id, gate_label, original_frame):
    state.person_in += 1
    state.interval_person_in += 1
    state.resample_hour_in += 1
    state.class_counts['in'] = state.person_in

    # Async DB update (non-blocking)
    db_queue_write(
        "UPDATE person_inout SET total_in = %s WHERE id = %s",
        (state.person_in, state.record_id)
    )

    send_person_in_mqtt(original_frame, state.record_id, "person_in")

    logging.info(
        f'Person {track_id} IN through {gate_label} - Total IN: {state.person_in}'
    )


def _count_out(track_id, gate_label, original_frame):
    state.person_out += 1
    state.interval_person_out += 1
    state.resample_hour_out += 1
    state.class_counts['out'] = state.person_out

    # Async DB update (non-blocking)
    db_queue_write(
        "UPDATE person_inout SET total_out = %s WHERE id = %s",
        (state.person_out, state.record_id)
    )

    send_person_in_mqtt(original_frame, state.record_id, "person_out")

    logging.info(
        f'Person {track_id} OUT through {gate_label} - Total OUT: {state.person_out}'
    )
```
with:
```python
def _count_in(track_id, gate_label, original_frame, box):
    state.person_in += 1
    state.interval_person_in += 1
    state.resample_hour_in += 1
    state.class_counts['in'] = state.person_in

    # Async DB update (non-blocking)
    db_queue_write(
        "UPDATE person_inout SET total_in = %s WHERE id = %s",
        (state.person_in, state.record_id)
    )

    send_person_in_mqtt(crop_image(original_frame, box), state.record_id, "person_in")

    logging.info(
        f'Person {track_id} IN through {gate_label} - Total IN: {state.person_in}'
    )


def _count_out(track_id, gate_label, original_frame, box):
    state.person_out += 1
    state.interval_person_out += 1
    state.resample_hour_out += 1
    state.class_counts['out'] = state.person_out

    # Async DB update (non-blocking)
    db_queue_write(
        "UPDATE person_inout SET total_out = %s WHERE id = %s",
        (state.person_out, state.record_id)
    )

    send_person_in_mqtt(crop_image(original_frame, box), state.record_id, "person_out")

    logging.info(
        f'Person {track_id} OUT through {gate_label} - Total OUT: {state.person_out}'
    )
```

- [ ] **Step 4: Pass `box` at all 4 call sites**

In the same file's `process_track()`, there are four calls (two in the `SWAP_IN_OUT` branch, two in the default branch). Replace each:
```python
                            _count_out(track_id, gate_label, original_frame)
```
→
```python
                            _count_out(track_id, gate_label, original_frame, (x1, y1, x2, y2))
```
```python
                            _count_in(track_id, gate_label, original_frame)
```
→
```python
                            _count_in(track_id, gate_label, original_frame, (x1, y1, x2, y2))
```
(There are 2 occurrences of each — use your editor's find-all-in-file since the surrounding indentation and context differ per branch but the text to match is identical.)

- [ ] **Step 5: Syntax-check the module**

Run: `cd python-counting && python -c "import ast; ast.parse(open('counting.py').read()); ast.parse(open('outputs/image_utils.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add python-counting/outputs/image_utils.py python-counting/counting.py
git commit -m "Fix person-event MQTT images to send a padded crop instead of the full frame"
```

---

### Task 3: `detection_events` DB writer

**Files:**
- Create: `python-counting/outputs/detection_events_db.py`

- [ ] **Step 1: Write the insert helper**

```python
"""Async insert into detection_events (APD/fire/smoke events). Uses the same
fire-and-forget queue as person_inout writes (outputs/db_worker.py).
"""
import uuid

import counting_config as cfg
from outputs.db_worker import db_queue_write


def insert_detection_event(detection_type, tag, label, track_id, confidence):
    """detection_type: 'apd' | 'fire' | 'smoke'. tag: 'info' | 'alarm'.
    track_id is None for fire/smoke (no tracker)."""
    db_queue_write(
        """
        INSERT INTO detection_events
            (id, device_id, device_code, device_name, detection_type, tag, label, track_id, confidence)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (str(uuid.uuid4()), cfg.device_id, cfg.device_code, cfg.device_name,
         detection_type, tag, label, track_id, confidence)
    )
```

- [ ] **Step 2: Syntax-check**

Run: `cd python-counting && python -c "import ast; ast.parse(open('outputs/detection_events_db.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add python-counting/outputs/detection_events_db.py
git commit -m "Add detection_events DB writer"
```

---

### Task 4: MQTT — tag the existing person payload, add a generic event publisher

**Files:**
- Modify: `python-counting/outputs/mqtt_out.py:71-79` (payload in `send_person_in_mqtt`)
- Modify: `python-counting/outputs/mqtt_out.py` (append new function after `send_person_in_mqtt`)

- [ ] **Step 1: Add `type`/`tag` to the existing person_in/out payload**

Replace:
```python
        # Create payload
        payload = {
            "record_id": record_id,
            "device_id": cfg.device_id,
            "device_code": cfg.device_code,
            "device_name": cfg.device_name,
            "timestamp": datetime.datetime.now(cfg.local_tz).isoformat(),
            "event": event_type,
            "image": base64.b64encode(image_bytes).decode('utf-8')
        }
```
with:
```python
        # Create payload
        payload = {
            "record_id": record_id,
            "device_id": cfg.device_id,
            "device_code": cfg.device_code,
            "device_name": cfg.device_name,
            "timestamp": datetime.datetime.now(cfg.local_tz).isoformat(),
            "event": event_type,
            "type": "people_counting",
            "tag": cfg.PEOPLE_COUNTING_TAG,
            "image": base64.b64encode(image_bytes).decode('utf-8')
        }
```

- [ ] **Step 2: Add a generic detection-event publisher**

Append this function to `python-counting/outputs/mqtt_out.py`, after `send_person_in_mqtt` and before `send_interval_mqtt_data`:
```python
def send_detection_event_mqtt(image, detection_type, tag, label, confidence, track_id=None):
    """Publish an APD/fire/smoke event. Reuses MQTT_TOPIC (distinguished by
    the 'type' field) rather than a separate topic, per design decision."""
    if cfg.DEBUG_MODE:
        logging.info(f"DEBUG_MODE: Skipping MQTT send for {detection_type}/{label}")
        return

    if mqtt_client is None:
        logging.warning("MQTT client not initialized, skipping detection event")
        return

    try:
        _, buffer = cv2.imencode('.jpg', image, [cv2.IMWRITE_JPEG_QUALITY, cfg.JPEG_QUALITY])
        image_bytes = buffer.tobytes()

        payload = {
            "device_id": cfg.device_id,
            "device_code": cfg.device_code,
            "device_name": cfg.device_name,
            "timestamp": datetime.datetime.now(cfg.local_tz).isoformat(),
            "event": f"{detection_type}_detected",
            "type": detection_type,
            "tag": tag,
            "label": label,
            "confidence": confidence,
            "track_id": track_id,
            "image": base64.b64encode(image_bytes).decode('utf-8'),
        }

        result = mqtt_client.publish(cfg.MQTT_TOPIC, json.dumps(payload), qos=1)
        if result.rc == mqtt.MQTT_ERR_SUCCESS:
            logging.info(f"{detection_type.upper()} event sent via MQTT (label={label}, conf={confidence:.2f})")
        else:
            logging.error(f"Failed to send MQTT message, error code: {result.rc}")
    except Exception as e:
        logging.error(f"Error sending detection event MQTT message: {e}")
```

- [ ] **Step 3: Syntax-check**

Run: `cd python-counting && python -c "import ast; ast.parse(open('outputs/mqtt_out.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add python-counting/outputs/mqtt_out.py
git commit -m "Add type/tag to MQTT payloads; add send_detection_event_mqtt for APD/fire/smoke"
```

---

### Task 5: New environment variables

**Files:**
- Modify: `python-counting/counting_config.py` (append after the `YOLO_IOU`/`TRITON_MODEL` block, before the `for _dep in (...)` deprecation-warning loop)
- Modify: `python-counting/app_state.py` (append two new state containers)

- [ ] **Step 1: Add the new config values**

In `python-counting/counting_config.py`, right after this existing block:
```python
_legacy_model = os.getenv('YOLO_MODEL', 'yolo11n.pt')
_default_triton_model = os.path.splitext(os.path.basename(_legacy_model))[0] + '_640'
TRITON_MODEL = os.getenv('TRITON_MODEL', _default_triton_model)
if not os.getenv('TRITON_MODEL'):
    logging.warning(
        f"TRITON_MODEL not set — derived '{TRITON_MODEL}' from legacy YOLO_MODEL={_legacy_model}"
    )
```
insert:
```python

# ADDITIONAL DETECTION (optional, run alongside person counting on the same frame)
PEOPLE_COUNTING_TAG = os.getenv('PEOPLE_COUNTING_TAG', 'info')

APD_ENABLED = os.getenv('APD_ENABLED', 'false').lower() == 'true'
APD_MODEL = os.getenv('APD_MODEL', '')
APD_CONFIDENCE = float(os.getenv('APD_CONFIDENCE', 0.3))
APD_TAG = os.getenv('APD_TAG', 'alarm')
if APD_ENABLED and not APD_MODEL:
    logging.warning("APD_ENABLED=true but APD_MODEL is not set — APD detection will be disabled")
    APD_ENABLED = False

FIRE_SMOKE_ENABLED = os.getenv('FIRE_SMOKE_ENABLED', 'false').lower() == 'true'
FIRE_SMOKE_MODEL = os.getenv('FIRE_SMOKE_MODEL', '')
FIRE_SMOKE_CONFIDENCE = float(os.getenv('FIRE_SMOKE_CONFIDENCE', 0.3))
FIRE_TAG = os.getenv('FIRE_TAG', 'alarm')
SMOKE_TAG = os.getenv('SMOKE_TAG', 'alarm')
FIRE_SMOKE_COOLDOWN_MINUTES = float(os.getenv('FIRE_SMOKE_COOLDOWN_MINUTES', 5))
if FIRE_SMOKE_ENABLED and not FIRE_SMOKE_MODEL:
    logging.warning("FIRE_SMOKE_ENABLED=true but FIRE_SMOKE_MODEL is not set — Fire/Smoke detection will be disabled")
    FIRE_SMOKE_ENABLED = False
```

- [ ] **Step 2: Add new state containers**

In `python-counting/app_state.py`, replace:
```python
# Store latest person coordinates for MQTT and bbox overlay
latest_person_coordinates = []
```
with:
```python
# Store latest person coordinates for MQTT and bbox overlay
latest_person_coordinates = []

# APD violation tracking: track_id -> set of violation labels already alerted
# (persists for the life of the track; cleared on tracker reset)
apd_alerted_tracks = defaultdict(set)

# Fire/Smoke cooldown: label -> last alert datetime
firesmoke_last_alert = {}
```

- [ ] **Step 3: Syntax-check both files**

Run: `cd python-counting && python -c "import ast; ast.parse(open('counting_config.py').read()); ast.parse(open('app_state.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add python-counting/counting_config.py python-counting/app_state.py
git commit -m "Add APD/Fire-Smoke environment variables and detection state containers"
```

---

### Task 6: Triton class-id → label resolution

**Files:**
- Create: `python-counting/inference/model_metadata.py`

- [ ] **Step 1: Write the metadata loader**

```python
"""Resolve Triton class ids to human-readable labels.

Triton's inference API only returns numeric class ids. The label names live in
metadata.json written by tools/export_model.py next to each model's ONNX file
in the shared models/ repository — which every camera container already has
read access to via its /app bind mount (docker-compose mounts the whole
python-counting/ directory, models/ included).
"""
from __future__ import annotations

import json
import logging
import os


def load_model_classes(model_name: str) -> dict[int, str]:
    """Return {class_id: label} for a Triton model, or {} if metadata is missing."""
    path = os.path.join('models', model_name, 'metadata.json')
    if not os.path.exists(path):
        logging.warning(
            f"No metadata.json for model '{model_name}' at {path} — "
            f"labels will show as class_<id>"
        )
        return {}
    try:
        with open(path) as f:
            meta = json.load(f)
        classes = meta.get('classes', {})
        return {int(k): v for k, v in classes.items()}
    except Exception as e:
        logging.error(f"Failed to load classes for model '{model_name}': {e}")
        return {}
```

- [ ] **Step 2: Syntax-check**

Run: `cd python-counting && python -c "import ast; ast.parse(open('inference/model_metadata.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add python-counting/inference/model_metadata.py
git commit -m "Add Triton model class-id to label resolution from metadata.json"
```

---

### Task 7: APD detection module (per-track dedup)

**Files:**
- Create: `python-counting/detection/__init__.py`
- Create: `python-counting/detection/apd.py`

- [ ] **Step 1: Create the package**

```bash
mkdir -p python-counting/detection
touch python-counting/detection/__init__.py
```

- [ ] **Step 2: Write the APD module**

```python
"""APD (PPE) violation detection: per-track dedup — a track_id fires at most
once per violation label for as long as that track exists. Mirrors the
'first-seen' style state dicts already used for line-crossing gates
(app_state.state_in / state_out).
"""
import logging

import app_state as state
import counting_config as cfg
from outputs.detection_events_db import insert_detection_event
from outputs.image_utils import crop_image
from outputs.mqtt_out import send_detection_event_mqtt


def process_detection(track_id, label, confidence, box, frame):
    """box: (x1, y1, x2, y2) in full-frame coordinates."""
    already_alerted = state.apd_alerted_tracks[track_id]
    if label in already_alerted:
        return
    already_alerted.add(label)

    crop = crop_image(frame, box)
    logging.info(f"APD violation: track {track_id} label={label} conf={confidence:.2f}")
    insert_detection_event('apd', cfg.APD_TAG, label, track_id, confidence)
    send_detection_event_mqtt(crop, 'apd', cfg.APD_TAG, label, confidence, track_id=track_id)
```

- [ ] **Step 3: Syntax-check**

Run: `cd python-counting && python -c "import ast; ast.parse(open('detection/apd.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add python-counting/detection/__init__.py python-counting/detection/apd.py
git commit -m "Add APD violation detection module (per-track dedup)"
```

---

### Task 8: Fire/Smoke detection module (cooldown)

**Files:**
- Create: `python-counting/detection/firesmoke.py`

- [ ] **Step 1: Write the module**

```python
"""Fire/Smoke detection: no tracker — cooldown per label, same pattern as the
existing MQTT interval-send guard (outputs/mqtt_out.py's should_send_interval_mqtt).
"""
import datetime
import logging

import app_state as state
import counting_config as cfg
from outputs.detection_events_db import insert_detection_event
from outputs.mqtt_out import send_detection_event_mqtt

_TAG_BY_LABEL = {'fire': lambda: cfg.FIRE_TAG, 'smoke': lambda: cfg.SMOKE_TAG}


def process_detection(label, confidence, frame):
    """frame: the full current frame (fire/smoke has no single bounding
    subject, so the whole frame is sent rather than a crop)."""
    if label not in _TAG_BY_LABEL:
        return

    now = datetime.datetime.now(cfg.local_tz)
    last = state.firesmoke_last_alert.get(label)
    if last is not None:
        elapsed = (now - last).total_seconds()
        if elapsed < cfg.FIRE_SMOKE_COOLDOWN_MINUTES * 60:
            return
    state.firesmoke_last_alert[label] = now

    tag = _TAG_BY_LABEL[label]()
    logging.info(f"{label.upper()} detected, conf={confidence:.2f} (tag={tag})")
    insert_detection_event(label, tag, label, None, confidence)
    send_detection_event_mqtt(frame, label, tag, label, confidence, track_id=None)
```

- [ ] **Step 2: Syntax-check**

Run: `cd python-counting && python -c "import ast; ast.parse(open('detection/firesmoke.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add python-counting/detection/firesmoke.py
git commit -m "Add Fire/Smoke detection module (per-label cooldown)"
```

---

### Task 9: Unit tests for dedup and cooldown logic

These test the state machines in isolation (no Triton/DB/MQTT connection —
`insert_detection_event`/`send_detection_event_mqtt` are monkeypatched to
record calls instead of hitting the network), following the existing
`tests/test_parity.py` style (plain assert-style script, no pytest dependency).

**Files:**
- Create: `python-counting/tests/test_detection_events.py`

- [ ] **Step 1: Write the test file**

```python
"""Unit tests for APD per-track dedup and Fire/Smoke cooldown logic — pure
state-machine tests, no Triton/DB/MQTT connection needed (those calls are
monkeypatched to record invocations instead of hitting the network).

Run from python-counting/:  python tests/test_detection_events.py
"""
import datetime
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault('SCREEN_RESOLUTION', '[800, 600]')
os.environ.setdefault('lineA', '[(0,0),(10,10)]')
os.environ.setdefault('DEBUG_MODE', 'true')
os.environ.setdefault('APD_TAG', 'alarm')
os.environ.setdefault('FIRE_TAG', 'alarm')
os.environ.setdefault('SMOKE_TAG', 'alarm')
os.environ.setdefault('FIRE_SMOKE_COOLDOWN_MINUTES', '5')

import numpy as np

PASS = FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name} {detail}")


def _fake_frame():
    return np.zeros((100, 100, 3), dtype=np.uint8)


def test_apd_dedup():
    print("[1] APD per-track dedup")
    import app_state as state
    from detection import apd

    calls = []
    apd.insert_detection_event = lambda *a, **k: calls.append(('db', a))
    apd.send_detection_event_mqtt = lambda *a, **k: calls.append(('mqtt', a))

    state.apd_alerted_tracks.clear()

    apd.process_detection(7, 'no_helmet', 0.8, (0, 0, 10, 10), _fake_frame())
    check("first violation fires one DB + one MQTT event", len(calls) == 2, f"calls={calls}")

    calls.clear()
    apd.process_detection(7, 'no_helmet', 0.9, (0, 0, 10, 10), _fake_frame())
    check("repeat violation for same track+label is suppressed", len(calls) == 0, f"calls={calls}")

    calls.clear()
    apd.process_detection(7, 'no_vest', 0.7, (0, 0, 10, 10), _fake_frame())
    check("different label on same track still fires", len(calls) == 2, f"calls={calls}")

    calls.clear()
    apd.process_detection(8, 'no_helmet', 0.8, (0, 0, 10, 10), _fake_frame())
    check("same label on a different track still fires", len(calls) == 2, f"calls={calls}")


def test_firesmoke_cooldown():
    print("[2] Fire/Smoke cooldown")
    import app_state as state
    import counting_config as cfg
    from detection import firesmoke

    calls = []
    firesmoke.insert_detection_event = lambda *a, **k: calls.append(('db', a))
    firesmoke.send_detection_event_mqtt = lambda *a, **k: calls.append(('mqtt', a))

    state.firesmoke_last_alert.clear()
    frame = _fake_frame()

    firesmoke.process_detection('fire', 0.9, frame)
    check("first fire detection fires one DB + one MQTT event", len(calls) == 2, f"calls={calls}")

    calls.clear()
    firesmoke.process_detection('fire', 0.95, frame)
    check("repeat fire within cooldown is suppressed", len(calls) == 0, f"calls={calls}")

    calls.clear()
    firesmoke.process_detection('smoke', 0.6, frame)
    check("smoke has an independent cooldown from fire", len(calls) == 2, f"calls={calls}")

    calls.clear()
    state.firesmoke_last_alert['fire'] = (
        datetime.datetime.now(cfg.local_tz)
        - datetime.timedelta(minutes=cfg.FIRE_SMOKE_COOLDOWN_MINUTES + 1)
    )
    firesmoke.process_detection('fire', 0.9, frame)
    check("fire re-fires after cooldown window elapses", len(calls) == 2, f"calls={calls}")

    calls.clear()
    firesmoke.process_detection('person', 0.9, frame)
    check("non fire/smoke labels are ignored", len(calls) == 0, f"calls={calls}")


if __name__ == '__main__':
    test_apd_dedup()
    test_firesmoke_cooldown()
    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)
```

- [ ] **Step 2: Run it and confirm every check passes**

Run: `cd python-counting && python tests/test_detection_events.py`
Expected: `[1] APD per-track dedup` and `[2] Fire/Smoke cooldown` sections all print `PASS`, final line `10 passed, 0 failed`, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add python-counting/tests/test_detection_events.py
git commit -m "Add unit tests for APD dedup and Fire/Smoke cooldown logic"
```

---

### Task 10: Wire APD and Fire/Smoke into `main.py`

**Files:**
- Modify: `python-counting/main.py:1-32` (module docstring + imports)
- Modify: `python-counting/main.py:195-203` (`reset_tracking_state`)
- Modify: `python-counting/main.py:256-266` (client/tracker setup before the outer `while True`)
- Modify: `python-counting/main.py:315-333` (inference block: add APD/Fire-Smoke calls after the person `tracks` line)
- Modify: `python-counting/main.py:385-388` (after the person for-loop: process APD/Fire-Smoke detections)
- Modify: `python-counting/main.py:325-329` (reconnect handling: also reset the APD tracker)

- [ ] **Step 1: Update imports**

Replace:
```python
import app_state as state
import counting_config as cfg
import lifecycle
from counting import process_track
from inference import TritonUnavailableError, TritonYoloClient
from outputs import bbox_writer, db_worker, mjpeg_server, mqtt_out
from tracking import BYTETracker, BYTETrackerArgs, Detections
```
with:
```python
import app_state as state
import counting_config as cfg
import lifecycle
from counting import process_track
from detection import apd, firesmoke
from inference import TritonUnavailableError, TritonYoloClient
from inference.model_metadata import load_model_classes
from outputs import bbox_writer, db_worker, mjpeg_server, mqtt_out
from tracking import BYTETracker, BYTETrackerArgs, Detections
```

- [ ] **Step 2: Reset the APD tracker alongside the person tracker on Triton reconnect**

Replace:
```python
def reset_tracking_state(tracker):
    """After a Triton outage, drop tracker + crossing state so stale Kalman
    predictions can't generate phantom crossings on reconnect."""
    tracker.reset()
    state.last_points.clear()
    state.prev_intersecting.clear()
    state.state_in.clear()
    state.state_out.clear()
    state.zone_inside_prev.clear()
```
with:
```python
def reset_tracking_state(tracker, apd_tracker=None):
    """After a Triton outage, drop tracker + crossing state so stale Kalman
    predictions can't generate phantom crossings on reconnect."""
    tracker.reset()
    state.last_points.clear()
    state.prev_intersecting.clear()
    state.state_in.clear()
    state.state_out.clear()
    state.zone_inside_prev.clear()
    if apd_tracker is not None:
        apd_tracker.reset()
        state.apd_alerted_tracks.clear()
```

- [ ] **Step 3: Create the optional APD/Fire-Smoke clients before the outer loop**

Replace:
```python
    # Shared-inference client + local tracker (replaces model.track)
    client = TritonYoloClient(
        cfg.TRITON_URL, cfg.TRITON_MODEL,
        conf_thresh=cfg.YOLO_CONFIDENCE, iou_thresh=cfg.YOLO_IOU, class_id=0,
    )
    tracker = BYTETracker(BYTETrackerArgs(), frame_rate=30)
    triton_backoff = TRITON_BACKOFF_MIN_S
    triton_was_down = False
    next_triton_retry = 0.0
```
with:
```python
    # Shared-inference client + local tracker (replaces model.track)
    client = TritonYoloClient(
        cfg.TRITON_URL, cfg.TRITON_MODEL,
        conf_thresh=cfg.YOLO_CONFIDENCE, iou_thresh=cfg.YOLO_IOU, class_id=0,
    )
    tracker = BYTETracker(BYTETrackerArgs(), frame_rate=30)
    triton_backoff = TRITON_BACKOFF_MIN_S
    triton_was_down = False
    next_triton_retry = 0.0

    # Optional additional detectors — independent model + (for APD) tracker.
    # class_id=None means "keep all classes" (these models aren't person-only).
    apd_client = None
    apd_tracker = None
    apd_classes = {}
    apd_next_retry = 0.0
    if cfg.APD_ENABLED:
        apd_client = TritonYoloClient(
            cfg.TRITON_URL, cfg.APD_MODEL, conf_thresh=cfg.APD_CONFIDENCE, class_id=None,
        )
        apd_tracker = BYTETracker(BYTETrackerArgs(), frame_rate=30)
        apd_classes = load_model_classes(cfg.APD_MODEL)
        logging.info(f"APD detection enabled: model={cfg.APD_MODEL} conf={cfg.APD_CONFIDENCE}")

    firesmoke_client = None
    firesmoke_classes = {}
    firesmoke_next_retry = 0.0
    if cfg.FIRE_SMOKE_ENABLED:
        firesmoke_client = TritonYoloClient(
            cfg.TRITON_URL, cfg.FIRE_SMOKE_MODEL, conf_thresh=cfg.FIRE_SMOKE_CONFIDENCE, class_id=None,
        )
        firesmoke_classes = load_model_classes(cfg.FIRE_SMOKE_MODEL)
        logging.info(f"Fire/Smoke detection enabled: model={cfg.FIRE_SMOKE_MODEL} conf={cfg.FIRE_SMOKE_CONFIDENCE}")
```

- [ ] **Step 4: Run the optional detectors after the person model's inference, with their own lightweight retry cooldown**

Replace:
```python
                if triton_was_down:
                    logging.info("[Triton] Reconnected — resetting tracker state")
                    reset_tracking_state(tracker)
                    triton_was_down = False
                triton_backoff = TRITON_BACKOFF_MIN_S

                # ---- Local ByteTrack (same tracker/config as legacy model.track) ----
                tracks = tracker.update(Detections(dets[:, :4], dets[:, 4], dets[:, 5]))
                # tracks rows: x1,y1,x2,y2,track_id,score,cls,det_idx (Kalman-smoothed)
```
with:
```python
                if triton_was_down:
                    logging.info("[Triton] Reconnected — resetting tracker state")
                    reset_tracking_state(tracker, apd_tracker)
                    triton_was_down = False
                triton_backoff = TRITON_BACKOFF_MIN_S

                # ---- Local ByteTrack (same tracker/config as legacy model.track) ----
                tracks = tracker.update(Detections(dets[:, :4], dets[:, 4], dets[:, 5]))
                # tracks rows: x1,y1,x2,y2,track_id,score,cls,det_idx (Kalman-smoothed)

                # ---- Optional APD detection (independent model + tracker) ----
                apd_tracks = []
                if apd_client is not None and time.time() >= apd_next_retry:
                    try:
                        apd_dets = apd_client.infer(detection_frame)
                        apd_tracks = apd_tracker.update(
                            Detections(apd_dets[:, :4], apd_dets[:, 4], apd_dets[:, 5])
                        )
                    except TritonUnavailableError as e:
                        logging.warning(f"APD inference unavailable, retrying in 30s: {e}")
                        apd_next_retry = time.time() + 30

                # ---- Optional Fire/Smoke detection (no tracker, cooldown-gated alerts) ----
                firesmoke_dets = None
                if firesmoke_client is not None and time.time() >= firesmoke_next_retry:
                    try:
                        firesmoke_dets = firesmoke_client.infer(detection_frame)
                    except TritonUnavailableError as e:
                        logging.warning(f"Fire/Smoke inference unavailable, retrying in 30s: {e}")
                        firesmoke_next_retry = time.time() + 30
```

- [ ] **Step 5: Process and draw APD/Fire-Smoke detections after the person for-loop**

Replace:
```python
                # bbox overlay file for the dashboard
                bbox_writer.write_bbox_file()
```
with:
```python
                # Process APD violations (per-track dedup; draws an orange box)
                for trk in apd_tracks:
                    track_id = int(trk[4])
                    conf = float(trk[5])
                    class_id = int(trk[6])
                    label = apd_classes.get(class_id, f'class_{class_id}')
                    ax1, ay1, ax2, ay2 = (int(v) for v in trk[:4])
                    ax1 += cfg.CROP_X1
                    ay1 += cfg.CROP_Y1
                    ax2 += cfg.CROP_X1
                    ay2 += cfg.CROP_Y1
                    if draw_now:
                        cv2.rectangle(frame, (ax1, ay1), (ax2, ay2), (0, 165, 255), 2)
                        cv2.putText(frame, label, (ax1, max(0, ay1 - 6)),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 165, 255), 2)
                    apd.process_detection(track_id, label, conf, (ax1, ay1, ax2, ay2), original_frame)

                # Process Fire/Smoke (cooldown-gated alerts; draws every live detection)
                if firesmoke_dets is not None:
                    for row in firesmoke_dets:
                        conf = float(row[4])
                        class_id = int(row[5])
                        label = firesmoke_classes.get(class_id, f'class_{class_id}')
                        if label not in ('fire', 'smoke'):
                            continue
                        fx1, fy1, fx2, fy2 = (int(v) for v in row[:4])
                        fx1 += cfg.CROP_X1
                        fy1 += cfg.CROP_Y1
                        fx2 += cfg.CROP_X1
                        fy2 += cfg.CROP_Y1
                        color = (0, 0, 255) if label == 'fire' else (128, 128, 128)
                        if draw_now:
                            cv2.rectangle(frame, (fx1, fy1), (fx2, fy2), color, 2)
                            cv2.putText(frame, label, (fx1, max(0, fy1 - 6)),
                                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
                        firesmoke.process_detection(label, conf, frame)

                # bbox overlay file for the dashboard
                bbox_writer.write_bbox_file()
```

- [ ] **Step 6: Syntax-check `main.py`**

Run: `cd python-counting && python -c "import ast; ast.parse(open('main.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 7: Commit**

```bash
git add python-counting/main.py
git commit -m "Wire optional APD and Fire/Smoke detectors into the main frame loop"
```

---

### Task 11: Document new env vars in `env_example`

**Files:**
- Modify: `python-counting/env_example`

- [ ] **Step 1: Add the new variables**

After this existing block:
```
# DEPRECATED (ignored since the Triton migration; kept for reference):
# YOLO_MODEL= "yolo26m.pt"     -> replaced by TRITON_MODEL
# YOLO_IMGSZ = 640             -> read from Triton model metadata
# ENABLE_NVDEC = 'true'        -> slim client image decodes in software
# YOLO_DEVICE = 'auto'         -> inference device is the Triton server's concern
```
insert:
```

# ADDITIONAL DETECTION (optional — runs alongside person counting on the same camera)
PEOPLE_COUNTING_TAG = 'info'

# APD_ENABLED = 'true'
# APD_MODEL = 'apd_640'
# APD_CONFIDENCE = '0.3'
# APD_TAG = 'alarm'

# FIRE_SMOKE_ENABLED = 'true'
# FIRE_SMOKE_MODEL = 'fire_smoke_640'
# FIRE_SMOKE_CONFIDENCE = '0.3'
# FIRE_TAG = 'alarm'
# SMOKE_TAG = 'alarm'
# FIRE_SMOKE_COOLDOWN_MINUTES = '5'
```

- [ ] **Step 2: Commit**

```bash
git add python-counting/env_example
git commit -m "Document APD/Fire-Smoke env vars in env_example"
```

---

### Task 12: Run the full python-counting test suite

- [ ] **Step 1: Run the parity suite (still applicable — unrelated to this change)**

Run: `cd python-counting && python tests/test_parity.py`
Expected: `10 passed, 0 failed` (unchanged from before this plan).

- [ ] **Step 2: Run the new detection-events suite**

Run: `cd python-counting && python tests/test_detection_events.py`
Expected: `10 passed, 0 failed`.

- [ ] **Step 3: Run the e2e smoke test**

Run: `cd python-counting && python tests/test_e2e_smoke.py`
Expected: `PASS` (this exercises the modified `main.py`/`counting.py` end-to-end on `1.mp4` — confirms the image-crop fix and new imports didn't break the existing pipeline; APD/Fire-Smoke stay disabled in this test since `APD_ENABLED`/`FIRE_SMOKE_ENABLED` aren't set).

If any test fails, stop and fix before proceeding — do not continue to the dashboard tasks with a broken pipeline.

---

## Part 2 — Dashboard

### Task 13: Add new fields to `DeviceEnvConfig` and `GlobalSettings`

**Files:**
- Modify: `dashboard/lib/types.ts:22-27` (`DeviceEnvConfig`)
- Modify: `dashboard/lib/types.ts:105-113` (`GlobalSettings.defaults` interface)
- Modify: `dashboard/lib/types.ts:136-144` (`DEFAULT_SETTINGS.defaults`)

- [ ] **Step 1: Add device env fields**

Replace:
```typescript
  TRITON_MODEL?: string;      // Triton model repository name (e.g. yolo26m_640)
  YOLO_IOU?: string;          // NMS IoU (raw-output fallback path only)
  YOLO_MODEL?: string;        // legacy (pre-Triton); used to derive TRITON_MODEL
  YOLO_CONFIDENCE: string;
  ENABLE_NVDEC?: string;      // legacy (pre-Triton); ignored by the thin client
```
with:
```typescript
  TRITON_MODEL?: string;      // Triton model repository name (e.g. yolo26m_640)
  YOLO_IOU?: string;          // NMS IoU (raw-output fallback path only)
  YOLO_MODEL?: string;        // legacy (pre-Triton); used to derive TRITON_MODEL
  YOLO_CONFIDENCE: string;
  ENABLE_NVDEC?: string;      // legacy (pre-Triton); ignored by the thin client
  PEOPLE_COUNTING_TAG?: string;   // 'info' | 'alarm' tag attached to person_in/out MQTT payloads
  APD_ENABLED?: string;
  APD_MODEL?: string;
  APD_CONFIDENCE?: string;
  APD_TAG?: string;               // 'info' | 'alarm'
  FIRE_SMOKE_ENABLED?: string;
  FIRE_SMOKE_MODEL?: string;
  FIRE_SMOKE_CONFIDENCE?: string;
  FIRE_TAG?: string;               // 'info' | 'alarm'
  SMOKE_TAG?: string;              // 'info' | 'alarm'
  FIRE_SMOKE_COOLDOWN_MINUTES?: string;
```

- [ ] **Step 2: Add global default fields to the interface**

Replace:
```typescript
  defaults: {
    debug_mode: string;
    mqtt_interval_minutes: string;
    daily_send_time: string;
    yolo_confidence: string;
    jpeg_quality: string;
    fps_limit: string;
    frame_skip: string;
  };
```
with:
```typescript
  defaults: {
    debug_mode: string;
    mqtt_interval_minutes: string;
    daily_send_time: string;
    yolo_confidence: string;
    jpeg_quality: string;
    fps_limit: string;
    frame_skip: string;
    people_counting_tag: string;
    apd_confidence: string;
    apd_tag: string;
    fire_smoke_confidence: string;
    fire_tag: string;
    smoke_tag: string;
    fire_smoke_cooldown_minutes: string;
  };
```

- [ ] **Step 3: Add matching defaults**

Replace:
```typescript
  defaults: {
    debug_mode: 'false',
    mqtt_interval_minutes: '5',
    daily_send_time: '23:59',
    yolo_confidence: '0.3',
    jpeg_quality: '40',
    fps_limit: '0',
    frame_skip: '2',
  },
};
```
with:
```typescript
  defaults: {
    debug_mode: 'false',
    mqtt_interval_minutes: '5',
    daily_send_time: '23:59',
    yolo_confidence: '0.3',
    jpeg_quality: '40',
    fps_limit: '0',
    frame_skip: '2',
    people_counting_tag: 'info',
    apd_confidence: '0.3',
    apd_tag: 'alarm',
    fire_smoke_confidence: '0.3',
    fire_tag: 'alarm',
    smoke_tag: 'alarm',
    fire_smoke_cooldown_minutes: '5',
  },
};
```

- [ ] **Step 4: Typecheck**

Run: `cd dashboard && ./node_modules/.bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/types.ts
git commit -m "Add APD/Fire-Smoke fields to DeviceEnvConfig and GlobalSettings"
```

---

### Task 14: Write the new env fields when a device is created or saved

**Files:**
- Modify: `dashboard/lib/env-parser.ts:94-100` (`writeDeviceEnv`, INFERENCE section)
- Modify: `dashboard/app/api/devices/route.ts:93-102` (POST handler defaults)

- [ ] **Step 1: Write the new keys in `writeDeviceEnv`**

Replace:
```typescript
    '# INFERENCE (Triton)',
    `TRITON_MODEL=${config.TRITON_MODEL ?? deriveTritonModel(config.YOLO_MODEL)}`,
    `YOLO_CONFIDENCE=${config.YOLO_CONFIDENCE ?? '0.3'}`,
    `YOLO_IOU=${config.YOLO_IOU ?? '0.3'}`,
    `JPEG_QUALITY=${config.JPEG_QUALITY ?? '40'}`,
    `FPS_LIMIT=${config.FPS_LIMIT ?? '0'}`,
    `FRAME_SKIP=${config.FRAME_SKIP ?? '2'}`,
    '',
```
with:
```typescript
    '# INFERENCE (Triton)',
    `TRITON_MODEL=${config.TRITON_MODEL ?? deriveTritonModel(config.YOLO_MODEL)}`,
    `YOLO_CONFIDENCE=${config.YOLO_CONFIDENCE ?? '0.3'}`,
    `YOLO_IOU=${config.YOLO_IOU ?? '0.3'}`,
    `JPEG_QUALITY=${config.JPEG_QUALITY ?? '40'}`,
    `FPS_LIMIT=${config.FPS_LIMIT ?? '0'}`,
    `FRAME_SKIP=${config.FRAME_SKIP ?? '2'}`,
    '',
    '# ADDITIONAL DETECTION',
    `PEOPLE_COUNTING_TAG=${config.PEOPLE_COUNTING_TAG ?? 'info'}`,
    `APD_ENABLED=${config.APD_ENABLED ?? 'false'}`,
    `APD_MODEL=${config.APD_MODEL ?? ''}`,
    `APD_CONFIDENCE=${config.APD_CONFIDENCE ?? '0.3'}`,
    `APD_TAG=${config.APD_TAG ?? 'alarm'}`,
    `FIRE_SMOKE_ENABLED=${config.FIRE_SMOKE_ENABLED ?? 'false'}`,
    `FIRE_SMOKE_MODEL=${config.FIRE_SMOKE_MODEL ?? ''}`,
    `FIRE_SMOKE_CONFIDENCE=${config.FIRE_SMOKE_CONFIDENCE ?? '0.3'}`,
    `FIRE_TAG=${config.FIRE_TAG ?? 'alarm'}`,
    `SMOKE_TAG=${config.SMOKE_TAG ?? 'alarm'}`,
    `FIRE_SMOKE_COOLDOWN_MINUTES=${config.FIRE_SMOKE_COOLDOWN_MINUTES ?? '5'}`,
    '',
```

- [ ] **Step 2: Pass global defaults through on device creation**

In `dashboard/app/api/devices/route.ts`, replace:
```typescript
      YOLO_CONFIDENCE: settings.defaults.yolo_confidence,
      ANNOTATED_STREAM: 'false',
      JPEG_QUALITY: settings.defaults.jpeg_quality,
      FPS_LIMIT: settings.defaults.fps_limit,
      FRAME_SKIP: settings.defaults.frame_skip,
```
with:
```typescript
      YOLO_CONFIDENCE: settings.defaults.yolo_confidence,
      ANNOTATED_STREAM: 'false',
      JPEG_QUALITY: settings.defaults.jpeg_quality,
      FPS_LIMIT: settings.defaults.fps_limit,
      FRAME_SKIP: settings.defaults.frame_skip,
      PEOPLE_COUNTING_TAG: settings.defaults.people_counting_tag,
      APD_ENABLED: 'false',
      APD_CONFIDENCE: settings.defaults.apd_confidence,
      APD_TAG: settings.defaults.apd_tag,
      FIRE_SMOKE_ENABLED: 'false',
      FIRE_SMOKE_CONFIDENCE: settings.defaults.fire_smoke_confidence,
      FIRE_TAG: settings.defaults.fire_tag,
      SMOKE_TAG: settings.defaults.smoke_tag,
      FIRE_SMOKE_COOLDOWN_MINUTES: settings.defaults.fire_smoke_cooldown_minutes,
```
(APD and Fire/Smoke are off by default for new cameras — models must be selected explicitly on the device page before enabling.)

- [ ] **Step 3: Typecheck**

Run: `cd dashboard && ./node_modules/.bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add dashboard/lib/env-parser.ts dashboard/app/api/devices/route.ts
git commit -m "Write APD/Fire-Smoke env vars when creating or saving a device"
```

---

### Task 15: Settings page — Additional Detection Defaults

**Files:**
- Modify: `dashboard/app/settings/page.tsx` (append a new `<Section>` after "Detection Defaults", before the final Save button `<div>`)

- [ ] **Step 1: Add a small reusable tag-select helper above the `SettingsPage` component**

At the top of `dashboard/app/settings/page.tsx`, after the existing imports, add:
```tsx
function TagSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
    >
      <option value="info">info</option>
      <option value="alarm">alarm</option>
    </select>
  );
}
```

- [ ] **Step 2: Insert the new Section**

Right after the closing `</Section>` of "Detection Defaults" and right before the final:
```tsx
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving}>
```
insert:
```tsx
      <Section title="Additional Detection Defaults">
        <p className="text-xs text-muted-foreground -mt-2">
          Applied when a new camera is created. APD and Fire/Smoke are disabled
          by default — enable them per camera once a model is selected.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <FormField label="People Counting Tag">
            <TagSelect value={settings.defaults.people_counting_tag} onChange={v => setDefault('people_counting_tag', v)} />
          </FormField>
          <FormField label="APD Confidence">
            <Input type="number" step="0.05" min="0" max="1" value={settings.defaults.apd_confidence} onChange={e => setDefault('apd_confidence', e.target.value)} />
          </FormField>
          <FormField label="APD Tag">
            <TagSelect value={settings.defaults.apd_tag} onChange={v => setDefault('apd_tag', v)} />
          </FormField>
          <FormField label="Fire/Smoke Confidence">
            <Input type="number" step="0.05" min="0" max="1" value={settings.defaults.fire_smoke_confidence} onChange={e => setDefault('fire_smoke_confidence', e.target.value)} />
          </FormField>
          <FormField label="Fire Tag">
            <TagSelect value={settings.defaults.fire_tag} onChange={v => setDefault('fire_tag', v)} />
          </FormField>
          <FormField label="Smoke Tag">
            <TagSelect value={settings.defaults.smoke_tag} onChange={v => setDefault('smoke_tag', v)} />
          </FormField>
          <FormField label="Fire/Smoke Cooldown (minutes)">
            <Input type="number" min="1" value={settings.defaults.fire_smoke_cooldown_minutes} onChange={e => setDefault('fire_smoke_cooldown_minutes', e.target.value)} />
          </FormField>
        </div>
      </Section>

```

- [ ] **Step 3: Typecheck**

Run: `cd dashboard && ./node_modules/.bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add dashboard/app/settings/page.tsx
git commit -m "Add Additional Detection Defaults section to Settings page"
```

---

### Task 16: Device page — Additional Detection section

This task assumes the Settings Simplification plan's Task 5 has already moved
the Detection Mode control into Basic Settings (right before the "Detection
Model (Triton)" `<Section>`). The new "Additional Detection" section is
inserted right after "Detection Model (Triton)".

**Files:**
- Modify: `dashboard/app/devices/[code]/page.tsx` (insert new Section after "Detection Model (Triton)", before the Save button)

- [ ] **Step 1: Insert the Additional Detection section**

Right after the closing `</Section>` of "Detection Model (Triton)" and right before:
```tsx
          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save Settings'}
            </Button>
          </div>
        </TabsContent>

        {/* ── LINE CONFIGURATION ── */}
```
insert:
```tsx
          <Section title="Additional Detection">
            <div className="space-y-5">
              <div className="space-y-3 rounded-md border border-border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">APD (PPE Violation) Detection</span>
                  <Switch
                    checked={env.APD_ENABLED === 'true'}
                    onCheckedChange={v => setField('APD_ENABLED', v ? 'true' : 'false')}
                  />
                </div>
                {env.APD_ENABLED === 'true' && (
                  <div className="grid grid-cols-2 gap-4">
                    <FormField label="Model">
                      {tritonModels.length > 0 ? (
                        <Select value={env.APD_MODEL || ''} onValueChange={v => v && setField('APD_MODEL', v)}>
                          <SelectTrigger><SelectValue placeholder="Select a model" /></SelectTrigger>
                          <SelectContent>
                            {tritonModels.map(m => (
                              <SelectItem key={m.name} value={m.name}>
                                {m.name} {m.state === 'READY' ? '● ready' : m.state === 'OFFLINE' ? '○ triton offline' : `(${m.state.toLowerCase()})`}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input value={env.APD_MODEL || ''} onChange={e => setField('APD_MODEL', e.target.value)} placeholder="apd_640" />
                      )}
                    </FormField>
                    <FormField label="Confidence (0.0–1.0)">
                      <Input type="number" step="0.05" min="0" max="1" value={env.APD_CONFIDENCE || '0.3'} onChange={e => setField('APD_CONFIDENCE', e.target.value)} />
                    </FormField>
                    <FormField label="Tag">
                      <Select value={env.APD_TAG || 'alarm'} onValueChange={v => v && setField('APD_TAG', v)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="info">info</SelectItem>
                          <SelectItem value="alarm">alarm</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormField>
                  </div>
                )}
              </div>

              <div className="space-y-3 rounded-md border border-border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Fire &amp; Smoke Detection</span>
                  <Switch
                    checked={env.FIRE_SMOKE_ENABLED === 'true'}
                    onCheckedChange={v => setField('FIRE_SMOKE_ENABLED', v ? 'true' : 'false')}
                  />
                </div>
                {env.FIRE_SMOKE_ENABLED === 'true' && (
                  <div className="grid grid-cols-2 gap-4">
                    <FormField label="Model">
                      {tritonModels.length > 0 ? (
                        <Select value={env.FIRE_SMOKE_MODEL || ''} onValueChange={v => v && setField('FIRE_SMOKE_MODEL', v)}>
                          <SelectTrigger><SelectValue placeholder="Select a model" /></SelectTrigger>
                          <SelectContent>
                            {tritonModels.map(m => (
                              <SelectItem key={m.name} value={m.name}>
                                {m.name} {m.state === 'READY' ? '● ready' : m.state === 'OFFLINE' ? '○ triton offline' : `(${m.state.toLowerCase()})`}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input value={env.FIRE_SMOKE_MODEL || ''} onChange={e => setField('FIRE_SMOKE_MODEL', e.target.value)} placeholder="fire_smoke_640" />
                      )}
                    </FormField>
                    <FormField label="Confidence (0.0–1.0)">
                      <Input type="number" step="0.05" min="0" max="1" value={env.FIRE_SMOKE_CONFIDENCE || '0.3'} onChange={e => setField('FIRE_SMOKE_CONFIDENCE', e.target.value)} />
                    </FormField>
                    <FormField label="Fire Tag">
                      <Select value={env.FIRE_TAG || 'alarm'} onValueChange={v => v && setField('FIRE_TAG', v)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="info">info</SelectItem>
                          <SelectItem value="alarm">alarm</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormField>
                    <FormField label="Smoke Tag">
                      <Select value={env.SMOKE_TAG || 'alarm'} onValueChange={v => v && setField('SMOKE_TAG', v)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="info">info</SelectItem>
                          <SelectItem value="alarm">alarm</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormField>
                    <FormField label="Cooldown (minutes)">
                      <Input type="number" min="1" value={env.FIRE_SMOKE_COOLDOWN_MINUTES || '5'} onChange={e => setField('FIRE_SMOKE_COOLDOWN_MINUTES', e.target.value)} />
                    </FormField>
                  </div>
                )}
              </div>
            </div>
          </Section>

```

- [ ] **Step 2: Typecheck**

Run: `cd dashboard && ./node_modules/.bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "dashboard/app/devices/[code]/page.tsx"
git commit -m "Add Additional Detection section (APD, Fire/Smoke) to device page"
```

---

### Task 17: Build and manual verification

- [ ] **Step 1: Full dashboard build**

Run: `cd dashboard && npm run build`
Expected: build succeeds, no type errors, route list unchanged (no new API routes added by this plan — reuses `/api/triton/models`).

- [ ] **Step 2: Verify Settings page**

Run: `cd dashboard && npm run dev`, open `/settings`. Confirm "Additional Detection Defaults" section renders with People Counting Tag, APD Confidence/Tag, Fire/Smoke Confidence/Fire Tag/Smoke Tag/Cooldown fields, all pre-filled with defaults. Change a value, save, reload — confirm it persists.

- [ ] **Step 3: Verify device page toggles**

Create a test camera (or reuse one), open its detail page → Basic Settings. Confirm:
- "Additional Detection" section appears below "Detection Model (Triton)".
- Toggling "APD (PPE Violation) Detection" reveals Model/Confidence/Tag fields; toggling it off hides them again.
- Toggling "Fire & Smoke Detection" reveals Model/Confidence/Fire Tag/Smoke Tag/Cooldown fields.
- Save Settings persists `APD_ENABLED=true`, `APD_MODEL=<chosen>`, etc. — confirm by reopening the page and seeing the toggle still on with the same values.

- [ ] **Step 4: End-to-end smoke with APD/Fire-Smoke enabled (requires a running Triton with a placeholder model)**

If a real APD/fire-smoke model isn't available yet, this step can be deferred — note it as a known gap rather than skipping silently. If a model IS available on Triton:
- Enable APD (or Fire/Smoke) on a test device pointing `FALLBACK_VIDEO=1.mp4`, set the model name to match an entry in Triton's repository index (`curl <triton>:8000/v2/repository/index -X POST`).
- Start the container, tail its logs (`docker logs -f <container>`), confirm no `TritonUnavailableError` spam and that `APD detection enabled: model=...` / `Fire/Smoke detection enabled: model=...` lines appear.
- If the model actually detects something in the test video, confirm a `detection_events` row appears (`SELECT * FROM detection_events ORDER BY created_at DESC LIMIT 5;`) and an MQTT message was published (subscribe to `MQTT_TOPIC` with `mosquitto_sub` and watch for a payload with `"type": "apd"` or `"type": "fire"/"smoke"`).

- [ ] **Step 5: Final commit (if any fixups were needed)**

```bash
git add -A
git commit -m "Fix issues found during Multi-Detection manual verification"
```
(Only run this if Steps 1-4 required code changes; otherwise there is nothing to commit here.)
