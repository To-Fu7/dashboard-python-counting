"""Async insert into detection_events (APD/fire/smoke events). Uses the same
fire-and-forget queue as person_inout writes (outputs/db_worker.py).
"""
import logging
import uuid

import counting_config as cfg
from outputs.db_worker import db_queue_write

# Validated here rather than by a DB CHECK constraint: CREATE TABLE IF NOT EXISTS
# can't update a constraint on already-provisioned databases, so a DB-side list
# would silently reject events for any type added later.
VALID_DETECTION_TYPES = ('apd', 'fire', 'smoke')


def insert_detection_event(detection_type, tag, label, track_id, confidence):
    """detection_type: one of VALID_DETECTION_TYPES. tag: 'info' | 'alarm'.
    track_id is None for fire/smoke (no tracker)."""
    if detection_type not in VALID_DETECTION_TYPES:
        logging.error(f"Unknown detection_type '{detection_type}' — event dropped")
        return
    db_queue_write(
        """
        INSERT INTO detection_events
            (id, device_id, device_code, device_name, detection_type, tag, label, track_id, confidence)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (str(uuid.uuid4()), cfg.device_id, cfg.device_code, cfg.device_name,
         detection_type, tag, label, track_id, confidence)
    )
