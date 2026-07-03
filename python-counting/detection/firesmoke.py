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
