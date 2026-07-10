"""Intrusion detection: a person present in a restricted zone (or crossing a
restricted line) during specific hours of day — an independent concept from
the main IN/OUT person counting (counting.py) and from the APD/Face
restriction zones (which only ever narrow where those detectors fire, never
add a time dimension). No model/tracker of its own: main.py feeds it the
already-tracked person detections from the main person tracker.

Per-track dedup — like face.py, a track fires at most one intrusion event for
its whole lifetime (no per-label distinction, unlike APD). Writes go to
intrusion_hourly (one row per hour, {"intrusion": N, "unique_persons": N} —
always equal, since every fired event is by definition a new/unique track,
same reasoning as face_hourly).
"""
import datetime
import logging

import cv2

import app_state as state
import counting_config as cfg
from counting import is_crossing_line
from outputs.hourly_aggregate_db import increment_hourly
from outputs.image_utils import crop_image
from outputs.mqtt_out import send_detection_event_mqtt


def is_time_active(now=None):
    """True if `now` (default: current local time) falls inside one of
    cfg.INTRUSION_TIME_RANGES, or if no ranges are configured at all
    (unrestricted — always active)."""
    if not cfg.INTRUSION_TIME_RANGES:
        return True
    now = now or datetime.datetime.now(cfg.local_tz)
    minute_of_day = now.hour * 60 + now.minute
    for r in cfg.INTRUSION_TIME_RANGES:
        start, end = r['start'], r['end']
        if start <= end:
            if start <= minute_of_day < end:
                return True
        else:  # wraps past midnight (e.g. 22:00-06:00)
            if minute_of_day >= start or minute_of_day < end:
                return True
    return False


def _triggered(track_id, cx, cy):
    """Zone/line trigger check per cfg.INTRUSION_DETECTION_MODE."""
    if cfg.INTRUSION_DETECTION_MODE == 'line_crossing':
        prev = state.intrusion_last_point.get(track_id)
        state.intrusion_last_point[track_id] = (cx, cy)
        if prev is None:
            return False
        return any(is_crossing_line(prev, (cx, cy), ln['line']) for ln in cfg.INTRUSION_LINES)

    # zone mode (default)
    for z in cfg.INTRUSION_ZONES:
        if cv2.pointPolygonTest(z['polygon'], (float(cx), float(cy)), False) >= 0:
            return True
    return False


def check_and_process(track_id, box, frame):
    """box: (x1, y1, x2, y2) in full-frame coordinates. Returns True if an
    intrusion event fired on this call (caller uses it to decide whether to
    keep drawing the alert box for this track)."""
    if track_id in state.intrusion_alerted_tracks:
        return False
    if not is_time_active():
        return False

    x1, y1, x2, y2 = box
    cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
    if not _triggered(track_id, cx, cy):
        return False

    state.intrusion_alerted_tracks.add(track_id)
    logging.info(f"Intrusion detected: track {track_id} at ({cx},{cy})")

    crop = crop_image(frame, box)
    increment_hourly('intrusion_hourly', cfg.device_id, cfg.device_code, cfg.device_name,
                      state.current_tracking_hour, 'intrusion')
    increment_hourly('intrusion_hourly', cfg.device_id, cfg.device_code, cfg.device_name,
                      state.current_tracking_hour, 'unique_persons')
    send_detection_event_mqtt(crop, 'intrusion', cfg.INTRUSION_TAG, 'intrusion', 1.0,
                               track_id=track_id, topic=cfg.MQTT_INTRUSION_TOPIC)
    return True
