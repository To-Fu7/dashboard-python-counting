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

VALID_HOURLY_TABLES = ('apd_hourly', 'firesmoke_hourly', 'face_hourly')


def increment_hourly(table, device_id, device_code, device_name, hour_start, label):
    """Increment data->>label by 1 for this device's hour_start row, creating
    the row first if it doesn't exist (defensive — pregenerate_day() should
    already have created it, but this stays correct either way). Async,
    fire-and-forget, same as the old insert_detection_event.

    Resets is_synced back to false on every update: in normal operation an
    increment only ever targets the current, not-yet-synced hour (state.
    current_tracking_hour only advances at hour rotation, same guarantee
    inout_resample's own interval updates rely on), so this is mostly a
    defensive no-op — but it's what keeps a rare late-arriving event (e.g.
    right at an hour boundary) from silently never reaching the central
    "server utama" database after the Node-RED sync job already marked that
    hour synced."""
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
            updated_at = now(),
            is_synced = false
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
