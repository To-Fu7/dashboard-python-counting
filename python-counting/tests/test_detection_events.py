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
    apd.increment_hourly = lambda *a, **k: calls.append(('hourly', a))
    apd.send_detection_event_mqtt = lambda *a, **k: calls.append(('mqtt', a))

    state.apd_alerted_tracks.clear()
    state.apd_unique_this_hour.clear()

    # First-ever sighting of track 7: label increment + unique_persons increment + mqtt = 3
    apd.process_detection(7, 'no_helmet', 0.8, (0, 0, 10, 10), _fake_frame())
    check("first violation for a new track fires label + unique_persons + mqtt",
          len(calls) == 3, f"calls={calls}")

    calls.clear()
    apd.process_detection(7, 'no_helmet', 0.9, (0, 0, 10, 10), _fake_frame())
    check("repeat violation for same track+label is suppressed", len(calls) == 0, f"calls={calls}")

    # Same track, new label: label increment + mqtt only — track 7 already
    # counted toward unique_persons, so that increment does NOT fire again.
    calls.clear()
    apd.process_detection(7, 'no_vest', 0.7, (0, 0, 10, 10), _fake_frame())
    check("different label on same track fires label + mqtt but not unique_persons again",
          len(calls) == 2, f"calls={calls}")

    # New track: label increment + unique_persons increment (first time track 8
    # is seen) + mqtt = 3
    calls.clear()
    apd.process_detection(8, 'no_helmet', 0.8, (0, 0, 10, 10), _fake_frame())
    check("same label on a different (new) track fires label + unique_persons + mqtt",
          len(calls) == 3, f"calls={calls}")


def test_firesmoke_cooldown():
    print("[2] Fire/Smoke cooldown")
    import app_state as state
    import counting_config as cfg
    from detection import firesmoke

    calls = []
    firesmoke.increment_hourly = lambda *a, **k: calls.append(('hourly', a))
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


def test_per_type_mqtt_topics():
    print("[3] Per-type MQTT topics (Part C)")
    import app_state as state
    import counting_config as cfg
    from detection import apd, firesmoke

    calls = []
    apd.increment_hourly = lambda *a, **k: None
    apd.send_detection_event_mqtt = lambda *a, **k: calls.append(k)
    firesmoke.increment_hourly = lambda *a, **k: None
    firesmoke.send_detection_event_mqtt = lambda *a, **k: calls.append(k)

    state.apd_alerted_tracks.clear()
    state.apd_unique_this_hour.clear()
    state.firesmoke_last_alert.clear()

    apd.process_detection(101, 'no_helmet', 0.8, (0, 0, 10, 10), _fake_frame())
    check("APD publishes to MQTT_APD_TOPIC, not the shared MQTT_TOPIC",
          calls[-1].get('topic') == cfg.MQTT_APD_TOPIC and calls[-1].get('topic') != cfg.MQTT_TOPIC,
          f"topic={calls[-1].get('topic')}")

    calls.clear()
    firesmoke.process_detection('fire', 0.9, _fake_frame())
    check("Fire/Smoke publishes to MQTT_FIRESMOKE_TOPIC, not the shared MQTT_TOPIC",
          calls[-1].get('topic') == cfg.MQTT_FIRESMOKE_TOPIC and calls[-1].get('topic') != cfg.MQTT_TOPIC,
          f"topic={calls[-1].get('topic')}")

    check("APD and Fire/Smoke topics are distinct from each other",
          cfg.MQTT_APD_TOPIC != cfg.MQTT_FIRESMOKE_TOPIC,
          f"apd={cfg.MQTT_APD_TOPIC} firesmoke={cfg.MQTT_FIRESMOKE_TOPIC}")


if __name__ == '__main__':
    test_apd_dedup()
    test_firesmoke_cooldown()
    test_per_type_mqtt_topics()
    finish()
