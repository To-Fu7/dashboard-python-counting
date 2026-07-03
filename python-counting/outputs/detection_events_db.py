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
