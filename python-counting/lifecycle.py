"""Counter lifecycle — startup restore, midnight reset, hourly resample rotation.
Extracted verbatim from legacy main.py (get_latest_counts, initialize_counts,
reset_counts, init_resample_record, handle_hour_change, should_reset).
"""
import datetime
import json
import logging
import uuid

import app_state as state
import counting_config as cfg
from outputs import hourly_aggregate_db
from outputs.db_worker import db_fetch, db_query
from outputs.mqtt_out import send_interval_mqtt_data


def should_reset():
    """Check if it's time to reset counters (midnight)"""
    now = datetime.datetime.now(cfg.local_tz)
    return now.hour == 0 and now.minute == 0 and now.second < 10


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
    if cfg.FACE_ENABLED:
        hourly_aggregate_db.pregenerate_day(
            'face_hourly', cfg.device_id, cfg.device_code, cfg.device_name, day_start)
    if cfg.INTRUSION_ENABLED:
        hourly_aggregate_db.pregenerate_day(
            'intrusion_hourly', cfg.device_id, cfg.device_code, cfg.device_name, day_start)


def get_latest_counts(device_id):
    """Get latest counts from database"""
    row = db_fetch(
        "SELECT id, total_in, total_out, data, created_at FROM person_inout WHERE device_id = %s ORDER BY created_at DESC LIMIT 1",
        (device_id,))
    if not row:
        return None, None, None, None

    last_device_id, total_in, total_out, data, last_created_utc = row
    last_id = {"id": last_device_id}
    last_data_json = {
        "in": total_in if total_in is not None else 0,
        "out": total_out if total_out is not None else 0
    }

    # Extract extra data (age/gender info) from database
    extra_data = None
    if data:
        try:
            if isinstance(data, dict):
                extra_data = data
            else:
                extra_data = json.loads(data)
        except (json.JSONDecodeError, Exception) as e:
            logging.warning(f"Error parsing extra data from DB: {e}")
            extra_data = None

    logging.info(f"Last record ID: {last_device_id}")

    last_created_local = last_created_utc.astimezone(cfg.local_tz)
    last_date_local = last_created_local.date()
    today_local = datetime.datetime.now(cfg.local_tz).date()

    if last_date_local == today_local:
        return last_data_json, last_date_local, last_id, extra_data

    return None, last_date_local, last_id, extra_data


def initialize_counts():
    """Initialize counters from database or create new record"""
    # Initialize interval counters
    state.interval_person_in = 0
    state.interval_person_out = 0

    if cfg.DEBUG_MODE:
        # Skip DB validation in debug mode
        new_id = str(uuid.uuid4())
        state.record_id = new_id
        state.class_counts['in'] = 0
        state.class_counts['out'] = 0
        state.person_in = 0
        state.person_out = 0
        logging.info(f"DEBUG_MODE: Skipping DB validation, initialized with new record id {new_id}")
        return {"id": new_id}

    restored_counts, last_date_local, last_data_id, extra_data = get_latest_counts(cfg.device_id)

    if restored_counts:
        state.class_counts.update(restored_counts)
        state.person_in = state.class_counts['in']
        state.person_out = state.class_counts['out']
        state.record_id = last_data_id['id']
        logging.info(f"Restored counts from DB ({last_date_local}): IN={state.person_in}, OUT={state.person_out}")
        init_resample_record()
        return last_data_id
    else:
        new_id = str(uuid.uuid4())
        success = db_query("INSERT INTO person_inout (id, device_id, total_in, total_out) VALUES (%s, %s, %s, %s)",
                           (new_id, cfg.device_id, 0, 0), commit=True)
        if success:
            state.record_id = new_id
            state.class_counts['in'] = 0
            state.class_counts['out'] = 0
            state.person_in = 0
            state.person_out = 0
            logging.info(f"No valid counts to restore, created new record with id {new_id}")
            init_resample_record()
            return {"id": new_id}
        else:
            logging.error("Failed to create new row")
            return None


def reset_counts():
    """Reset counts at midnight"""
    # Send final daily report before reset
    send_interval_mqtt_data()

    state.person_in, state.person_out = 0, 0
    state.interval_person_in, state.interval_person_out = 0, 0
    state.resample_hour_in, state.resample_hour_out = 0, 0
    state.class_counts.clear()
    state.class_counts['in'] = 0
    state.class_counts['out'] = 0
    state.state_in.clear()
    state.state_out.clear()
    state.prev_intersecting.clear()
    state.zone_inside_prev.clear()
    state.person_history.clear()
    state.apd_unique_this_hour.clear()

    new_id = str(uuid.uuid4())

    if cfg.DEBUG_MODE:
        state.record_id = new_id
        state.last_mqtt_send = None
        logging.info("== Midnight Reached: Totals Reset (DEBUG_MODE: Skipping DB operation) ==")
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


def init_resample_record():
    """Upsert an inout_resample row for the current hour slot."""
    current_time = datetime.datetime.now(cfg.local_tz)
    hour_slot = current_time.replace(minute=0, second=0, microsecond=0)
    state.current_tracking_hour = hour_slot

    result = db_fetch(
        """
        INSERT INTO inout_resample (device_id, device_name, device_code, interval_in, interval_out, hour_start)
        VALUES (%s, %s, %s, 0, 0, %s)
        ON CONFLICT (device_id, hour_start) DO UPDATE
            SET device_name = EXCLUDED.device_name,
                device_code = EXCLUDED.device_code
        RETURNING id, interval_in, interval_out
        """,
        (cfg.device_id, cfg.device_name, cfg.device_code, hour_slot),
        commit=True,
    )

    if result:
        state.resample_record_id = result[0]
        state.resample_hour_in = result[1]
        state.resample_hour_out = result[2]
        logging.info(f"Resample record upserted for {hour_slot}: IN={state.resample_hour_in}, OUT={state.resample_hour_out}")
    else:
        logging.error(f"Failed to upsert resample record for {hour_slot}")


def handle_hour_change():
    """Send final interval data for the completed hour, then start tracking the new hour."""
    send_interval_mqtt_data()
    state.resample_hour_in = 0
    state.resample_hour_out = 0
    state.apd_unique_this_hour.clear()
    init_resample_record()
