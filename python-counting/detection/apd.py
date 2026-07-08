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

    send_detection_event_mqtt(crop, 'apd', cfg.APD_TAG, label, confidence,
                               track_id=track_id, topic=cfg.MQTT_APD_TOPIC)
