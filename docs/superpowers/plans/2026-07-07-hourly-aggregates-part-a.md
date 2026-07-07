# Hourly Aggregates (Part A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-event DB writes for APD/fire-smoke with hourly aggregate rows (one row per device per hour, upserted in place, JSONB label counters), and pre-generate a full day's 24 hourly rows up front (for `inout_resample` too) so consumers always see a complete day instead of rows appearing one at a time as hours pass.

**Architecture:** New `outputs/hourly_aggregate_db.py` provides `increment_hourly()` (upsert-increment a JSONB counter) and `pregenerate_day()` (bulk-insert 24 zero-valued rows via `generate_series`), both going through the existing async `db_queue_write`/sync `db_query` machinery — no new connection pattern. `lifecycle.py` gains `pregenerate_hourly_tables()` orchestrating this for `inout_resample` (always) plus `apd_hourly`/`firesmoke_hourly` (if enabled), called at startup and at midnight rollover. `detection/apd.py` and `detection/firesmoke.py` swap their `insert_detection_event()` call for `increment_hourly()`. The old per-event `detection_events` table and `outputs/detection_events_db.py` are removed entirely.

**Tech Stack:** Python 3.11 (python-counting), PostgreSQL (JSONB + `generate_series`), existing `psycopg2`/async queue infra — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-07-hourly-aggregates-face-detection-mqtt-topics-design.md` (Part A only — Parts B and C are separate, later plans)

---

### Task 1: Schema — `apd_hourly`/`firesmoke_hourly`, drop `detection_events`

**Files:**
- Modify: `python-counting/init_db.py`

- [ ] **Step 1: Replace the `detection_events` block with the two new hourly tables**

Replace:
```python
    """
    CREATE TABLE IF NOT EXISTS detection_events (
        id UUID PRIMARY KEY,
        device_id UUID NOT NULL,
        device_code TEXT NOT NULL,
        device_name TEXT,
        detection_type TEXT NOT NULL,
        tag TEXT NOT NULL CHECK (tag IN ('info', 'alarm')),
        label TEXT NOT NULL,
        track_id INTEGER,
        confidence REAL NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_detection_events_device_time ON detection_events (device_id, created_at DESC)",
]
```
with:
```python
    """
    CREATE TABLE IF NOT EXISTS apd_hourly (
        device_id UUID NOT NULL,
        device_code TEXT NOT NULL,
        device_name TEXT,
        hour_start TIMESTAMPTZ NOT NULL,
        data JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (device_id, hour_start)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_apd_hourly_device_time ON apd_hourly (device_id, hour_start DESC)",
    """
    CREATE TABLE IF NOT EXISTS firesmoke_hourly (
        device_id UUID NOT NULL,
        device_code TEXT NOT NULL,
        device_name TEXT,
        hour_start TIMESTAMPTZ NOT NULL,
        data JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (device_id, hour_start)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_firesmoke_hourly_device_time ON firesmoke_hourly (device_id, hour_start DESC)",
]
```

- [ ] **Step 2: Update the module docstring and final log line**

Replace:
```python
"""One-stop database provisioning: creates person_inout, inout_resample, and
detection_events if they don't already exist. Safe to run repeatedly.
```
with:
```python
"""One-stop database provisioning: creates person_inout, inout_resample,
apd_hourly, and firesmoke_hourly if they don't already exist. Safe to run
repeatedly.
```

Replace:
```python
        logging.info("Schema is up to date (person_inout, inout_resample, detection_events).")
```
with:
```python
        logging.info("Schema is up to date (person_inout, inout_resample, apd_hourly, firesmoke_hourly).")
```

- [ ] **Step 3: Syntax-check**

Run: `cd python-counting && python -c "import ast; ast.parse(open('init_db.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add python-counting/init_db.py
git commit -m "Replace detection_events with apd_hourly/firesmoke_hourly schema"
```

---

### Task 2: `outputs/hourly_aggregate_db.py` — increment + pregenerate helpers

**Files:**
- Create: `python-counting/outputs/hourly_aggregate_db.py`
- Delete: `python-counting/outputs/detection_events_db.py`

- [ ] **Step 1: Write the new module**

```python
"""Hourly aggregate writes for APD/fire-smoke (and, later, face) detection —
one row per (device, hour_start), each label a running JSONB counter,
incremented in place. Replaces the old per-event detection_events table.

Both functions are safe against SQL injection despite the f-string table name:
`table` is always one of VALID_HOURLY_TABLES (checked below), never derived
from event data; `label` — which IS event-derived — is always a bound `%s`
parameter, never interpolated into the query text.
"""
import logging

from outputs.db_worker import db_query, db_queue_write

VALID_HOURLY_TABLES = ('apd_hourly', 'firesmoke_hourly')


def increment_hourly(table, device_id, device_code, device_name, hour_start, label):
    """Increment data->>label by 1 for this device's hour_start row, creating
    the row first if it doesn't exist (defensive — pregenerate_day() should
    already have created it, but this stays correct either way). Async,
    fire-and-forget, same as the old insert_detection_event."""
    if table not in VALID_HOURLY_TABLES:
        logging.error(f"Unknown hourly table '{table}' — increment dropped")
        return
    query = f"""
        INSERT INTO {table} (device_id, device_code, device_name, hour_start, data)
        VALUES (%s, %s, %s, %s, jsonb_build_object(%s, 1))
        ON CONFLICT (device_id, hour_start) DO UPDATE
        SET data = jsonb_set(
                {table}.data,
                array[%s],
                to_jsonb(COALESCE(({table}.data ->> %s)::int, 0) + 1)
            ),
            updated_at = now()
    """
    db_queue_write(query, (device_id, device_code, device_name, hour_start, label, label, label))


def pregenerate_day(table, device_id, device_code, device_name, day_start):
    """Bulk-create all 24 hourly rows for a day (day_start=00:00 .. +23h),
    each starting at data={}. Synchronous (not the async queue) — this runs
    once at startup/midnight and callers want to know it completed before
    proceeding. ON CONFLICT DO NOTHING: re-running never touches existing
    counts, so it's safe to call on every startup."""
    if table not in VALID_HOURLY_TABLES:
        logging.error(f"Unknown hourly table '{table}' — pregeneration skipped")
        return
    query = f"""
        INSERT INTO {table} (device_id, device_code, device_name, hour_start, data)
        SELECT %s, %s, %s, %s + (n || ' hours')::interval, '{{}}'::jsonb
        FROM generate_series(0, 23) AS n
        ON CONFLICT (device_id, hour_start) DO NOTHING
    """
    db_query(query, (device_id, device_code, device_name, day_start), commit=True)
```

- [ ] **Step 2: Delete the superseded module**

```bash
rm python-counting/outputs/detection_events_db.py
```

- [ ] **Step 3: Syntax-check**

Run: `cd python-counting && python -c "import ast; ast.parse(open('outputs/hourly_aggregate_db.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add python-counting/outputs/hourly_aggregate_db.py
git rm python-counting/outputs/detection_events_db.py
git commit -m "Add hourly_aggregate_db (increment/pregenerate); remove detection_events_db"
```

(Note: `apd.py`/`firesmoke.py` still import the deleted module at this point — the repo is intentionally broken between this task and Task 6/7. This is fine within a single work session; don't run the full test suite until Task 7 is done. If executing via subagent-driven-development, mention this ordering to the implementer so a mid-sequence "tests fail" isn't mistaken for a regression.)

---

### Task 3: `app_state.py` — per-hour unique-person tracking

**Files:**
- Modify: `python-counting/app_state.py`

- [ ] **Step 1: Add the new state container**

Replace:
```python
# APD violation tracking: track_id -> set of violation labels already alerted
# (persists for the life of the track; cleared on tracker reset)
apd_alerted_tracks = defaultdict(set)

# Fire/Smoke cooldown: label -> last alert datetime
firesmoke_last_alert = {}
```
with:
```python
# APD violation tracking: track_id -> set of violation labels already alerted
# (persists for the life of the track; cleared on tracker reset)
apd_alerted_tracks = defaultdict(set)

# APD unique-person-per-hour tracking: track_ids already counted toward
# apd_hourly's "unique_persons" counter this hour (cleared on hour rotation
# and on APD tracker reset — a reset tracker recycles ids, and a new hour
# should start its unique count from zero).
apd_unique_this_hour = set()

# Fire/Smoke cooldown: label -> last alert datetime
firesmoke_last_alert = {}
```

- [ ] **Step 2: Syntax-check**

Run: `cd python-counting && python -c "import ast; ast.parse(open('app_state.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add python-counting/app_state.py
git commit -m "Add apd_unique_this_hour state for hourly unique-person counting"
```

---

### Task 4: `lifecycle.py` — pregeneration + hour-rotation clearing

**Files:**
- Modify: `python-counting/lifecycle.py`

- [ ] **Step 1: Add the import**

Replace:
```python
import app_state as state
import counting_config as cfg
from outputs.db_worker import db_fetch, db_query
from outputs.mqtt_out import send_interval_mqtt_data
```
with:
```python
import app_state as state
import counting_config as cfg
from outputs import hourly_aggregate_db
from outputs.db_worker import db_fetch, db_query
from outputs.mqtt_out import send_interval_mqtt_data
```

- [ ] **Step 2: Add `pregenerate_hourly_tables()`**

Insert this new function right after `should_reset()` (before `get_latest_counts`):
```python
def pregenerate_hourly_tables(day_date):
    """Bulk-create the day's 24 hourly rows for inout_resample (always) and
    any enabled per-type table — so consumers see a complete day immediately
    rather than rows appearing one at a time as each hour is reached. Safe to
    call at startup and at midnight rollover; ON CONFLICT DO NOTHING means
    re-running it never touches existing counts, including on a mid-day
    restart after a detection type was just enabled (it backfills 00:00
    through the current hour with zero placeholders in the same call)."""
    day_start = datetime.datetime.combine(day_date, datetime.time(0, 0), tzinfo=cfg.local_tz)

    db_query(
        """
        INSERT INTO inout_resample (device_id, device_name, device_code, interval_in, interval_out, hour_start)
        SELECT %s, %s, %s, 0, 0, %s + (n || ' hours')::interval
        FROM generate_series(0, 23) AS n
        ON CONFLICT (device_id, hour_start) DO NOTHING
        """,
        (cfg.device_id, cfg.device_name, cfg.device_code, day_start),
        commit=True,
    )

    if cfg.APD_ENABLED:
        hourly_aggregate_db.pregenerate_day(
            'apd_hourly', cfg.device_id, cfg.device_code, cfg.device_name, day_start)
    if cfg.FIRE_SMOKE_ENABLED:
        hourly_aggregate_db.pregenerate_day(
            'firesmoke_hourly', cfg.device_id, cfg.device_code, cfg.device_name, day_start)
```

- [ ] **Step 3: Clear `apd_unique_this_hour` on both rollover paths**

Replace:
```python
    state.state_in.clear()
    state.state_out.clear()
    state.prev_intersecting.clear()
    state.zone_inside_prev.clear()
    state.person_history.clear()

    new_id = str(uuid.uuid4())
```
with:
```python
    state.state_in.clear()
    state.state_out.clear()
    state.prev_intersecting.clear()
    state.zone_inside_prev.clear()
    state.person_history.clear()
    state.apd_unique_this_hour.clear()

    new_id = str(uuid.uuid4())
```

Replace:
```python
def handle_hour_change():
    """Send final interval data for the completed hour, then start tracking the new hour."""
    send_interval_mqtt_data()
    state.resample_hour_in = 0
    state.resample_hour_out = 0
    init_resample_record()
```
with:
```python
def handle_hour_change():
    """Send final interval data for the completed hour, then start tracking the new hour."""
    send_interval_mqtt_data()
    state.resample_hour_in = 0
    state.resample_hour_out = 0
    state.apd_unique_this_hour.clear()
    init_resample_record()
```

- [ ] **Step 4: Pregenerate the new day at midnight, before switching to hour 0**

Replace:
```python
    else:
        success = db_query("INSERT INTO person_inout (id, device_id, total_in, total_out) VALUES (%s, %s, %s, %s)",
                           (new_id, cfg.device_id, 0, 0), commit=True)
        if success:
            state.record_id = new_id
            state.last_mqtt_send = None
            logging.info("== Midnight Reached: Totals Reset ==")
        else:
            logging.error("Error creating new record at midnight")

    init_resample_record()
```
with:
```python
    else:
        success = db_query("INSERT INTO person_inout (id, device_id, total_in, total_out) VALUES (%s, %s, %s, %s)",
                           (new_id, cfg.device_id, 0, 0), commit=True)
        if success:
            state.record_id = new_id
            state.last_mqtt_send = None
            logging.info("== Midnight Reached: Totals Reset ==")
        else:
            logging.error("Error creating new record at midnight")

    pregenerate_hourly_tables(datetime.datetime.now(cfg.local_tz).date())
    init_resample_record()
```

- [ ] **Step 5: Syntax-check**

Run: `cd python-counting && python -c "import ast; ast.parse(open('lifecycle.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add python-counting/lifecycle.py
git commit -m "Pregenerate hourly tables at midnight; clear apd_unique_this_hour on rotation"
```

---

### Task 5: `main.py` — pregenerate at startup, clear on APD tracker reset

**Files:**
- Modify: `python-counting/main.py`

- [ ] **Step 1: Pregenerate today's hourly rows before restoring counts**

Replace:
```python
    if not cfg.DEBUG_MODE and not db_worker.init_db():
        return
    last_data_id = lifecycle.initialize_counts()
```
with:
```python
    if not cfg.DEBUG_MODE and not db_worker.init_db():
        return
    lifecycle.pregenerate_hourly_tables(datetime.datetime.now(cfg.local_tz).date())
    last_data_id = lifecycle.initialize_counts()
```

- [ ] **Step 2: Also clear the per-hour unique-count on APD tracker reset**

Replace:
```python
def reset_apd_state(apd_tracker):
    """Tracker reset and alert-dedup clear must always happen together —
    a reset tracker reuses track ids, so stale dedup entries would either
    suppress fresh alerts or re-alert on recycled ids."""
    apd_tracker.reset()
    state.apd_alerted_tracks.clear()
```
with:
```python
def reset_apd_state(apd_tracker):
    """Tracker reset and dedup-state clear must always happen together —
    a reset tracker reuses track ids, so stale dedup/unique-count entries
    would either suppress fresh alerts or miscount uniqueness on recycled
    ids."""
    apd_tracker.reset()
    state.apd_alerted_tracks.clear()
    state.apd_unique_this_hour.clear()
```

- [ ] **Step 3: Syntax-check**

Run: `cd python-counting && python -c "import ast; ast.parse(open('main.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add python-counting/main.py
git commit -m "Pregenerate today's hourly rows at startup; clear unique-count on APD reset"
```

---

### Task 6: `detection/apd.py` — switch to hourly increments + unique count

**Files:**
- Modify: `python-counting/detection/apd.py`

- [ ] **Step 1: Replace the whole file**

```python
"""APD (PPE) violation detection: per-track dedup — a track_id fires at most
once per violation label for as long as that track exists. Mirrors the
'first-seen' style state dicts already used for line-crossing gates
(app_state.state_in / state_out).

Writes go to apd_hourly (one row per hour, JSONB label counters) rather than
a per-event table — label counts increment every distinct (track, label)
first-seen event; unique_persons increments once per track per hour,
independent of how many distinct labels that track triggers.
"""
import logging

import app_state as state
import counting_config as cfg
from outputs.hourly_aggregate_db import increment_hourly
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

    increment_hourly('apd_hourly', cfg.device_id, cfg.device_code, cfg.device_name,
                      state.current_tracking_hour, label)
    if track_id not in state.apd_unique_this_hour:
        state.apd_unique_this_hour.add(track_id)
        increment_hourly('apd_hourly', cfg.device_id, cfg.device_code, cfg.device_name,
                          state.current_tracking_hour, 'unique_persons')

    send_detection_event_mqtt(crop, 'apd', cfg.APD_TAG, label, confidence, track_id=track_id)
```

- [ ] **Step 2: Syntax-check**

Run: `cd python-counting && python -c "import ast; ast.parse(open('detection/apd.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add python-counting/detection/apd.py
git commit -m "APD: write to apd_hourly (label + unique_persons counters) instead of detection_events"
```

---

### Task 7: `detection/firesmoke.py` — switch to hourly increments

**Files:**
- Modify: `python-counting/detection/firesmoke.py`

- [ ] **Step 1: Replace the whole file**

```python
"""Fire/Smoke detection: no tracker — cooldown per label, same pattern as the
existing MQTT interval-send guard (outputs/mqtt_out.py's should_send_interval_mqtt).

Writes go to firesmoke_hourly (one row per hour, JSONB label counters) rather
than a per-event table — no unique_persons concept here (no tracker), just a
running count per label per hour.
"""
import datetime
import logging

import app_state as state
import counting_config as cfg
from outputs.hourly_aggregate_db import increment_hourly
from outputs.mqtt_out import send_detection_event_mqtt


def process_detection(label, confidence, frame):
    """frame: the full current frame (fire/smoke has no single bounding
    subject, so the whole frame is sent rather than a crop)."""
    if label not in ('fire', 'smoke'):
        return

    now = datetime.datetime.now(cfg.local_tz)
    last = state.firesmoke_last_alert.get(label)
    if last is not None:
        elapsed = (now - last).total_seconds()
        if elapsed < cfg.FIRE_SMOKE_COOLDOWN_MINUTES * 60:
            return
    state.firesmoke_last_alert[label] = now

    tag = cfg.FIRE_TAG if label == 'fire' else cfg.SMOKE_TAG
    logging.info(f"{label.upper()} detected, conf={confidence:.2f} (tag={tag})")

    increment_hourly('firesmoke_hourly', cfg.device_id, cfg.device_code, cfg.device_name,
                      state.current_tracking_hour, label)
    send_detection_event_mqtt(frame, label, tag, label, confidence, track_id=None)
```

- [ ] **Step 2: Syntax-check**

Run: `cd python-counting && python -c "import ast; ast.parse(open('detection/firesmoke.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add python-counting/detection/firesmoke.py
git commit -m "Fire/Smoke: write to firesmoke_hourly instead of detection_events"
```

---

### Task 8: Update `tests/test_detection_events.py` for the new call shape

The old assertions counted `insert_detection_event` + `send_detection_event_mqtt`
calls (2 per fired event). APD now fires 1-2 `increment_hourly` calls (label,
plus `unique_persons` only the first time a track is seen this hour) plus 1
MQTT call — so the exact counts change for APD; fire/smoke's counts are
unchanged (still 1 DB write + 1 MQTT per fired event).

**Files:**
- Modify: `python-counting/tests/test_detection_events.py`

- [ ] **Step 1: Update the APD test's monkeypatch target and expected counts**

Replace:
```python
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
```
with:
```python
def test_apd_dedup():
    print("[1] APD per-track dedup")
    import app_state as state
    from detection import apd

    calls = []
    apd.increment_hourly = lambda *a, **k: calls.append(('hourly', a))
    apd.send_detection_event_mqtt = lambda *a, **k: calls.append(('mqtt', a))

    state.apd_alerted_tracks.clear()
    state.apd_unique_this_hour.clear()

    # First-ever sighting of track 7: label increment + unique_persons increment + mqtt = 3
    apd.process_detection(7, 'no_helmet', 0.8, (0, 0, 10, 10), _fake_frame())
    check("first violation for a new track fires label + unique_persons + mqtt",
          len(calls) == 3, f"calls={calls}")

    calls.clear()
    apd.process_detection(7, 'no_helmet', 0.9, (0, 0, 10, 10), _fake_frame())
    check("repeat violation for same track+label is suppressed", len(calls) == 0, f"calls={calls}")

    # Same track, new label: label increment + mqtt only — track 7 already
    # counted toward unique_persons, so that increment does NOT fire again.
    calls.clear()
    apd.process_detection(7, 'no_vest', 0.7, (0, 0, 10, 10), _fake_frame())
    check("different label on same track fires label + mqtt but not unique_persons again",
          len(calls) == 2, f"calls={calls}")

    # New track: label increment + unique_persons increment (first time track 8
    # is seen) + mqtt = 3
    calls.clear()
    apd.process_detection(8, 'no_helmet', 0.8, (0, 0, 10, 10), _fake_frame())
    check("same label on a different (new) track fires label + unique_persons + mqtt",
          len(calls) == 3, f"calls={calls}")
```

- [ ] **Step 2: Update the fire/smoke test's monkeypatch target (counts unchanged)**

Replace:
```python
    calls = []
    firesmoke.insert_detection_event = lambda *a, **k: calls.append(('db', a))
    firesmoke.send_detection_event_mqtt = lambda *a, **k: calls.append(('mqtt', a))
```
with:
```python
    calls = []
    firesmoke.increment_hourly = lambda *a, **k: calls.append(('hourly', a))
    firesmoke.send_detection_event_mqtt = lambda *a, **k: calls.append(('mqtt', a))
```
(No other change needed in `test_firesmoke_cooldown` — every existing
`check(..., len(calls) == 2, ...)` / `== 0` assertion still holds, since
fire/smoke still fires exactly one DB write + one MQTT call per event.)

- [ ] **Step 3: Run it and confirm every check passes**

Run: `cd python-counting && python tests/test_detection_events.py`
Expected: all checks print `PASS`, final line `9 passed, 0 failed` (same
count as before — 4 APD checks + 5 fire/smoke checks — only the APD
assertions' *content* changed, the count of checks is the same).

- [ ] **Step 4: Commit**

```bash
git add python-counting/tests/test_detection_events.py
git commit -m "Update APD/fire-smoke dedup tests for increment_hourly call shape"
```

---

### Task 9: New tests for `hourly_aggregate_db` and `pregenerate_hourly_tables`

**Files:**
- Create: `python-counting/tests/test_hourly_aggregate.py`

- [ ] **Step 1: Write the test file**

These test the SQL-shape and parameter-safety properties of the new helpers
by monkeypatching `db_query`/`db_queue_write` to capture calls instead of
hitting a real database — same style as `tests/test_detection_events.py`.

```python
"""Unit tests for outputs.hourly_aggregate_db — pure call-shape assertions,
no real Postgres needed (db_query/db_queue_write are monkeypatched to record
invocations, matching the style of tests/test_detection_events.py).

Run from python-counting/:  python tests/test_hourly_aggregate.py
"""
import datetime

from testutil import check, finish  # bootstraps sys.path + base env vars

import counting_config as cfg
from outputs import hourly_aggregate_db as had


def test_increment_hourly_valid_table():
    print("[1] increment_hourly — valid table")
    calls = []
    had.db_queue_write = lambda query, params: calls.append((query, params))

    hour = datetime.datetime.now(cfg.local_tz).replace(minute=0, second=0, microsecond=0)
    had.increment_hourly('apd_hourly', 'dev-1', 'CODE1', 'Cam One', hour, 'no_helmet')

    check("exactly one query queued", len(calls) == 1, f"calls={calls}")
    query, params = calls[0]
    check("query targets apd_hourly", 'apd_hourly' in query, query)
    check("query has ON CONFLICT upsert", 'ON CONFLICT' in query, query)
    check("label appears 3 times as a bound param (build, path, lookup)",
          params.count('no_helmet') == 3, f"params={params}")
    check("no other table name leaked into the query", 'firesmoke_hourly' not in query, query)


def test_increment_hourly_rejects_unknown_table():
    print("[2] increment_hourly — unknown table is rejected, not queried")
    calls = []
    had.db_queue_write = lambda query, params: calls.append((query, params))

    had.increment_hourly('not_a_real_table', 'dev-1', 'CODE1', 'Cam One',
                          datetime.datetime.now(cfg.local_tz), 'x')
    check("no query queued for an unknown table", len(calls) == 0, f"calls={calls}")


def test_pregenerate_day_valid_table():
    print("[3] pregenerate_day — valid table")
    calls = []
    had.db_query = lambda query, params, commit=False: calls.append((query, params, commit))

    day_start = datetime.datetime.now(cfg.local_tz).replace(hour=0, minute=0, second=0, microsecond=0)
    had.pregenerate_day('firesmoke_hourly', 'dev-1', 'CODE1', 'Cam One', day_start)

    check("exactly one query executed", len(calls) == 1, f"calls={calls}")
    query, params, commit = calls[0]
    check("query targets firesmoke_hourly", 'firesmoke_hourly' in query, query)
    check("query generates 24 hours via generate_series(0, 23)",
          'generate_series(0, 23)' in query, query)
    check("query is ON CONFLICT DO NOTHING (never clobbers existing counts)",
          'DO NOTHING' in query, query)
    check("commit=True (synchronous, not the async queue)", commit is True)
    check("day_start passed through as the 4th positional param",
          params[3] == day_start, f"params={params}")


def test_pregenerate_day_rejects_unknown_table():
    print("[4] pregenerate_day — unknown table is rejected, not queried")
    calls = []
    had.db_query = lambda query, params, commit=False: calls.append((query, params, commit))

    had.pregenerate_day('not_a_real_table', 'dev-1', 'CODE1', 'Cam One',
                         datetime.datetime.now(cfg.local_tz))
    check("no query executed for an unknown table", len(calls) == 0, f"calls={calls}")


if __name__ == '__main__':
    test_increment_hourly_valid_table()
    test_increment_hourly_rejects_unknown_table()
    test_pregenerate_day_valid_table()
    test_pregenerate_day_rejects_unknown_table()
    finish()
```

- [ ] **Step 2: Run it and confirm every check passes**

Run: `cd python-counting && python tests/test_hourly_aggregate.py`
Expected: all checks `PASS`, final line `11 passed, 0 failed`, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add python-counting/tests/test_hourly_aggregate.py
git commit -m "Add unit tests for hourly_aggregate_db increment/pregenerate helpers"
```

---

### Task 10: Full verification — unit tests, e2e smoke, and a real database

- [ ] **Step 1: Run the full python-counting unit test suite**

Run from `python-counting/`:
```bash
python tests/test_parity.py
python tests/test_image_utils.py
python tests/test_detection_events.py
python tests/test_hourly_aggregate.py
```
Expected: `10 passed, 0 failed`, `11 passed, 0 failed`, `9 passed, 0 failed`,
`11 passed, 0 failed` respectively — all four green.

- [ ] **Step 2: Run the e2e smoke test**

Run: `python tests/test_e2e_smoke.py`
Expected: `Processed 150 frames crash-free... PASS`. `APD_ENABLED`/
`FIRE_SMOKE_ENABLED` are unset in this test's environment, so
`pregenerate_hourly_tables()` only touches `inout_resample` here — confirms
the new startup call doesn't break the existing person-counting path when
run in `DEBUG_MODE` (all DB calls no-op per `cfg.DEBUG_MODE` guards already
inside `db_query`/`db_queue_write`).

- [ ] **Step 3: Verify against a real PostgreSQL/TimescaleDB instance**

This is the one property that can't be verified by mocking `db_query`: that
the actual SQL (JSONB path operators, `generate_series`, `ON CONFLICT`
targeting a composite unique constraint) is valid Postgres syntax that
behaves as intended. If you have access to a reachable Postgres/TimescaleDB
(e.g. the project's playground server, or a local `docker run postgres`),
run this from `python-counting/` with real `PG_*` env vars pointing at it:

```bash
python init_db.py   # creates apd_hourly / firesmoke_hourly, drops nothing existing
python - <<'EOF'
import datetime
import os
os.environ.setdefault('SCREEN_RESOLUTION', '[800,600]')
os.environ.setdefault('lineA', '[(0,0),(10,10)]')
os.environ['DEBUG_MODE'] = 'false'

import counting_config as cfg
from outputs import db_worker, hourly_aggregate_db as had

db_worker.init_db()
day_start = datetime.datetime.now(cfg.local_tz).replace(hour=0, minute=0, second=0, microsecond=0)

had.pregenerate_day('apd_hourly', cfg.device_id or 'test-device', 'TESTCODE', 'Test Cam', day_start)
had.increment_hourly('apd_hourly', cfg.device_id or 'test-device', 'TESTCODE', 'Test Cam',
                      day_start, 'no_helmet')
had.increment_hourly('apd_hourly', cfg.device_id or 'test-device', 'TESTCODE', 'Test Cam',
                      day_start, 'no_helmet')

import time
time.sleep(1)  # let the async db_worker thread flush the queued increments
db_worker.db_thread_running = False
EOF
```

Then query directly to confirm the day was pre-generated with 24 rows and
the label counter reached 2:
```bash
psql "$DATABASE_URL" -c "SELECT count(*) FROM apd_hourly WHERE device_id::text = 'test-device' OR device_code = 'TESTCODE';"
psql "$DATABASE_URL" -c "SELECT hour_start, data FROM apd_hourly WHERE data ? 'no_helmet';"
```
Expected: 24 rows for the day, and the one row containing `no_helmet` shows
`{"no_helmet": 2}`. Clean up the test rows afterward
(`DELETE FROM apd_hourly WHERE device_code = 'TESTCODE';`) since they're
synthetic test data, not a real camera's counts.

If no reachable Postgres is available in your environment, note this
explicitly rather than skipping silently — this step is what actually proves
the JSONB/generate_series SQL is correct, which the mocked unit tests in
Task 9 cannot verify.

- [ ] **Step 4: Final commit (if any fixups were needed)**

```bash
git add -A
git commit -m "Fix issues found during hourly-aggregate verification"
```
(Only run this if Steps 1-3 required code changes; otherwise there is
nothing to commit here.)
