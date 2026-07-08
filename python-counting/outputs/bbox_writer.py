"""Write bbox_<DEVICE_CODE>.json for the dashboard's bbox overlay endpoint
(/api/devices/[code]/bbox reads {ts, boxes, resolution} and treats data older
than 5s as stale). Throttled to ~2 writes/second.
"""
import json
import logging
import os
import time

import app_state as state
import counting_config as cfg

_last_bbox_write = 0.0
_WRITE_INTERVAL_S = 0.5


def write_bbox_file():
    global _last_bbox_write
    if not cfg.device_code:
        return
    now = time.time()
    if now - _last_bbox_write < _WRITE_INTERVAL_S:
        return
    _last_bbox_write = now

    payload = {
        "ts": now,
        "boxes": state.latest_person_coordinates,
        "resolution": [state.actual_resolution[0], state.actual_resolution[1]],
    }
    path = f"bbox_{cfg.device_code}.json"
    tmp = path + ".tmp"
    try:
        with open(tmp, 'w') as f:
            json.dump(payload, f)
        os.replace(tmp, path)  # atomic so the dashboard never reads a half-written file
    except Exception as e:
        logging.debug(f"bbox write failed: {e}")
