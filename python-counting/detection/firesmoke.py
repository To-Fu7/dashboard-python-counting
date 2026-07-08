"""Fire/Smoke detection: no tracker — cooldown per label, same pattern as the
existing MQTT interval-send guard (outputs/mqtt_out.py's should_send_interval_mqtt).
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
    send_detection_event_mqtt(frame, label, tag, label, confidence,
                               track_id=None, topic=cfg.MQTT_FIRESMOKE_TOPIC)
