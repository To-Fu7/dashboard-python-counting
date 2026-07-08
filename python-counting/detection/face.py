"""Face detection/recognition: per-track dedup — a track_id fires at most one
event (insider-with-name or intruder) for the life of that track, the first
time it's classified. Unlike APD (which dedups per label), a face track only
ever needs one verdict, so state.face_alerted_tracks is a plain set.

Matching (cosine similarity vs the in-memory known_faces cache) happens
upstream in main.py, which passes the resolved label/tag/similarity here —
same responsibility split as apd.py (main.py owns the Triton/tracker wiring,
this module owns dedup + the hourly-aggregate/MQTT write path).

Writes go to face_hourly (one row per hour, JSONB counters keyed by person
name or "intruder", plus unique_persons) rather than a per-event table. Since
a track fires at most once ever, every fired event is by definition a new
unique person for that hour — no separate per-hour tracking is needed here
(contrast with APD, where a single track can trigger multiple distinct
label events).
"""
import logging

import app_state as state
import counting_config as cfg
from outputs.hourly_aggregate_db import increment_hourly
from outputs.image_utils import crop_image
from outputs.mqtt_out import send_detection_event_mqtt


def process_detection(track_id, label, tag, similarity, box, frame):
    """label: matched person_name, or "intruder" if no match.
    box: (x1, y1, x2, y2) in full-frame coordinates."""
    if track_id in state.face_alerted_tracks:
        return
    state.face_alerted_tracks.add(track_id)

    crop = crop_image(frame, box)
    logging.info(f"Face event: track {track_id} label={label} similarity={similarity:.2f}")

    increment_hourly('face_hourly', cfg.device_id, cfg.device_code, cfg.device_name,
                      state.current_tracking_hour, label)
    increment_hourly('face_hourly', cfg.device_id, cfg.device_code, cfg.device_name,
                      state.current_tracking_hour, 'unique_persons')

    send_detection_event_mqtt(crop, 'face', tag, label, similarity,
                               track_id=track_id, topic=cfg.MQTT_FACE_TOPIC)
