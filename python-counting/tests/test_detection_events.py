"""Unit tests for APD per-track dedup and Fire/Smoke cooldown logic — pure
state-machine tests, no Triton/DB/MQTT connection needed (those calls are
monkeypatched to record invocations instead of hitting the network).

Run from python-counting/:  python tests/test_detection_events.py
"""
import datetime
import os

from testutil import check, finish  # bootstraps sys.path + base env vars

os.environ.setdefault('APD_TAG', 'alarm')
os.environ.setdefault('FIRE_TAG', 'alarm')
os.environ.setdefault('SMOKE_TAG', 'alarm')
os.environ.setdefault('FIRE_SMOKE_COOLDOWN_MINUTES', '5')

import numpy as np


def _fake_frame():
    return np.zeros((100, 100, 3), dtype=np.uint8)


def test_apd_dedup():
    print("[1] APD per-track dedup")
    import app_state as state
    from detection import apd

    calls = []
    apd.insert_detection_event = lambda *a, **k: calls.append(('db', a))
    apd.send_detection_event_mqtt = lambda *a, **k: calls.append(('mqtt', a))

    state.apd_alerted_tracks.clear()

    apd.process_detection(7, 'no_helmet', 0.8, (0, 0, 10, 10), _fake_frame())
    check("first violation fires one DB + one MQTT event", len(calls) == 2, f"calls={calls}")

    calls.clear()
    apd.process_detection(7, 'no_helmet', 0.9, (0, 0, 10, 10), _fake_frame())
    check("repeat violation for same track+label is suppressed", len(calls) == 0, f"calls={calls}")

    calls.clear()
    apd.process_detection(7, 'no_vest', 0.7, (0, 0, 10, 10), _fake_frame())
    check("different label on same track still fires", len(calls) == 2, f"calls={calls}")

    calls.clear()
    apd.process_detection(8, 'no_helmet', 0.8, (0, 0, 10, 10), _fake_frame())
    check("same label on a different track still fires", len(calls) == 2, f"calls={calls}")


def test_firesmoke_cooldown():
    print("[2] Fire/Smoke cooldown")
    import app_state as state
    import counting_config as cfg
    from detection import firesmoke

    calls = []
    firesmoke.insert_detection_event = lambda *a, **k: calls.append(('db', a))
    firesmoke.send_detection_event_mqtt = lambda *a, **k: calls.append(('mqtt', a))

    state.firesmoke_last_alert.clear()
    frame = _fake_frame()

    firesmoke.process_detection('fire', 0.9, frame)
    check("first fire detection fires one DB + one MQTT event", len(calls) == 2, f"calls={calls}")

    calls.clear()
    firesmoke.process_detection('fire', 0.95, frame)
    check("repeat fire within cooldown is suppressed", len(calls) == 0, f"calls={calls}")

    calls.clear()
    firesmoke.process_detection('smoke', 0.6, frame)
    check("smoke has an independent cooldown from fire", len(calls) == 2, f"calls={calls}")

    calls.clear()
    state.firesmoke_last_alert['fire'] = (
        datetime.datetime.now(cfg.local_tz)
        - datetime.timedelta(minutes=cfg.FIRE_SMOKE_COOLDOWN_MINUTES + 1)
    )
    firesmoke.process_detection('fire', 0.9, frame)
    check("fire re-fires after cooldown window elapses", len(calls) == 2, f"calls={calls}")

    calls.clear()
    firesmoke.process_detection('person', 0.9, frame)
    check("non fire/smoke labels are ignored", len(calls) == 0, f"calls={calls}")


if __name__ == '__main__':
    test_apd_dedup()
    test_firesmoke_cooldown()
    finish()
