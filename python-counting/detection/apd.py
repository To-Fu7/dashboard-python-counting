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
