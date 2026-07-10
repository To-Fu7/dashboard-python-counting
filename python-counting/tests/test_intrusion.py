"""Unit tests for intrusion detection: the multi-range time-of-day gate
(counting_config.load_time_ranges_from_env / detection.intrusion.is_time_active),
the single-line loader (counting_config.load_lines_from_env), and the
zone/line trigger + per-track dedup (detection/intrusion.py). Pure logic
tests — no Triton/DB/MQTT connection needed (those calls are monkeypatched).

Run from python-counting/:  python tests/test_intrusion.py
"""
import datetime
import os

from testutil import check, finish  # bootstraps sys.path + base env vars

import numpy as np

import counting_config as cfg


def _fake_frame():
    return np.zeros((100, 100, 3), dtype=np.uint8)


def test_load_time_ranges_from_env():
    print("[1] load_time_ranges_from_env parses lettered HH:MM-HH:MM ranges")
    os.environ['testTimeA'] = '12:00-24:00'
    os.environ['testTimeB'] = '00:00-08:00'
    try:
        ranges = cfg.load_time_ranges_from_env(prefix='testTime')
        check("two ranges loaded", len(ranges) == 2, f"ranges={ranges}")
        check("first range parsed to minutes", ranges[0]['start'] == 12 * 60 and ranges[0]['end'] == 24 * 60,
              f"ranges={ranges}")
        check("second range parsed to minutes", ranges[1]['start'] == 0 and ranges[1]['end'] == 8 * 60,
              f"ranges={ranges}")
    finally:
        del os.environ['testTimeA']
        del os.environ['testTimeB']

    check("no vars set at all -> empty list (unrestricted)",
          cfg.load_time_ranges_from_env(prefix='noSuchPrefix') == [])


def test_load_lines_from_env():
    print("[2] load_lines_from_env (single lines, not in/out gate pairs)")
    os.environ['testLineA'] = '[(0,0),(100,100)]'
    try:
        lines = cfg.load_lines_from_env(prefix='testLine')
        check("one line loaded", len(lines) == 1, f"lines={lines}")
        check("line has exactly 2 points", lines[0]['line'] == [(0, 0), (100, 100)], f"lines={lines}")
    finally:
        del os.environ['testLineA']

    os.environ['testLineA'] = '[(0,0),(1,1),(2,2)]'  # 3 points: invalid, must be skipped
    try:
        lines = cfg.load_lines_from_env(prefix='testLine')
        check("a 3-point value is rejected, not silently truncated", len(lines) == 0, f"lines={lines}")
    finally:
        del os.environ['testLineA']


def test_is_time_active_no_ranges_configured():
    print("[3] is_time_active: no ranges configured -> always active")
    from detection import intrusion
    cfg.INTRUSION_TIME_RANGES = []
    check("unrestricted when empty", intrusion.is_time_active() is True)


def test_is_time_active_non_wrapping_range():
    print("[4] is_time_active: a plain (non-wrapping) range")
    from detection import intrusion
    cfg.INTRUSION_TIME_RANGES = [{'name': 'A', 'start': 12 * 60, 'end': 24 * 60}]

    inside = datetime.datetime(2026, 1, 1, 14, 0, tzinfo=cfg.local_tz)
    outside = datetime.datetime(2026, 1, 1, 9, 0, tzinfo=cfg.local_tz)
    check("14:00 is inside 12:00-24:00", intrusion.is_time_active(inside) is True)
    check("09:00 is outside 12:00-24:00", intrusion.is_time_active(outside) is False)


def test_is_time_active_wrapping_range():
    print("[5] is_time_active: a single wrap-around range (end <= start)")
    from detection import intrusion
    cfg.INTRUSION_TIME_RANGES = [{'name': 'A', 'start': 22 * 60, 'end': 6 * 60}]

    late_night = datetime.datetime(2026, 1, 1, 23, 0, tzinfo=cfg.local_tz)
    early_morning = datetime.datetime(2026, 1, 1, 3, 0, tzinfo=cfg.local_tz)
    daytime = datetime.datetime(2026, 1, 1, 12, 0, tzinfo=cfg.local_tz)
    check("23:00 is inside a 22:00-06:00 wrap range", intrusion.is_time_active(late_night) is True)
    check("03:00 is inside a 22:00-06:00 wrap range", intrusion.is_time_active(early_morning) is True)
    check("12:00 is outside a 22:00-06:00 wrap range", intrusion.is_time_active(daytime) is False)


def test_is_time_active_multiple_ranges():
    print("[6] is_time_active: incremental (more than one) ranges, matches ANY of them")
    from detection import intrusion
    cfg.INTRUSION_TIME_RANGES = [
        {'name': 'A', 'start': 12 * 60, 'end': 24 * 60},
        {'name': 'B', 'start': 0, 'end': 8 * 60},
    ]
    morning = datetime.datetime(2026, 1, 1, 6, 0, tzinfo=cfg.local_tz)
    afternoon = datetime.datetime(2026, 1, 1, 15, 0, tzinfo=cfg.local_tz)
    business_hours = datetime.datetime(2026, 1, 1, 10, 0, tzinfo=cfg.local_tz)
    check("06:00 matches the second range", intrusion.is_time_active(morning) is True)
    check("15:00 matches the first range", intrusion.is_time_active(afternoon) is True)
    check("10:00 (business hours) matches neither range", intrusion.is_time_active(business_hours) is False)


def test_intrusion_dedup_zone_mode():
    print("[7] Intrusion per-track dedup in zone mode (fires once per track, ever)")
    import app_state as state
    from detection import intrusion

    calls = []
    intrusion.increment_hourly = lambda *a, **k: calls.append(('hourly', a))
    intrusion.send_detection_event_mqtt = lambda *a, **k: calls.append(('mqtt', a))

    state.intrusion_alerted_tracks.clear()
    state.intrusion_last_point.clear()
    cfg.INTRUSION_TIME_RANGES = []  # always active
    cfg.INTRUSION_DETECTION_MODE = 'zone'
    cfg.INTRUSION_ZONES = [{'name': 'intrusionZoneA',
                             'polygon': np.array([[0, 0], [100, 0], [100, 100], [0, 100]], dtype=np.float32)}]

    fired = intrusion.check_and_process(7, (40, 40, 60, 60), _fake_frame())
    check("first sighting inside the zone fires", fired is True)
    check("fires exactly: intrusion + unique_persons + mqtt", len(calls) == 3, f"calls={calls}")

    calls.clear()
    fired_again = intrusion.check_and_process(7, (40, 40, 60, 60), _fake_frame())
    check("same track again is suppressed (dedup)", fired_again is False and len(calls) == 0, f"calls={calls}")

    calls.clear()
    fired_outside = intrusion.check_and_process(8, (500, 500, 520, 520), _fake_frame())
    check("a different track outside the zone does not fire", fired_outside is False and len(calls) == 0,
          f"calls={calls}")


def test_intrusion_time_gate_suppresses_zone_hit():
    print("[8] Intrusion: even inside the zone, outside active hours never fires")
    import app_state as state
    from detection import intrusion

    calls = []
    intrusion.increment_hourly = lambda *a, **k: calls.append(('hourly', a))
    intrusion.send_detection_event_mqtt = lambda *a, **k: calls.append(('mqtt', a))

    state.intrusion_alerted_tracks.clear()
    state.intrusion_last_point.clear()
    cfg.INTRUSION_DETECTION_MODE = 'zone'
    cfg.INTRUSION_ZONES = [{'name': 'intrusionZoneA',
                             'polygon': np.array([[0, 0], [100, 0], [100, 100], [0, 100]], dtype=np.float32)}]
    cfg.INTRUSION_TIME_RANGES = [{'name': 'A', 'start': 0, 'end': 8 * 60}]  # 00:00-08:00 only

    # is_time_active() uses datetime.now() internally with no override arg here,
    # so instead we directly assert the gate is what blocks it by monkeypatching
    # is_time_active to simulate "outside active hours".
    original_is_time_active = intrusion.is_time_active
    intrusion.is_time_active = lambda *a, **k: False
    try:
        fired = intrusion.check_and_process(9, (40, 40, 60, 60), _fake_frame())
        check("inside the zone but outside active hours does not fire",
              fired is False and len(calls) == 0, f"calls={calls}")
    finally:
        intrusion.is_time_active = original_is_time_active


def test_intrusion_line_crossing_mode():
    print("[9] Intrusion in line_crossing mode: needs a prior point, then a real crossing")
    import app_state as state
    from detection import intrusion

    calls = []
    intrusion.increment_hourly = lambda *a, **k: calls.append(('hourly', a))
    intrusion.send_detection_event_mqtt = lambda *a, **k: calls.append(('mqtt', a))

    state.intrusion_alerted_tracks.clear()
    state.intrusion_last_point.clear()
    cfg.INTRUSION_TIME_RANGES = []  # always active
    cfg.INTRUSION_DETECTION_MODE = 'line_crossing'
    cfg.INTRUSION_LINES = [{'name': 'intrusionLineA', 'line': [(0, 50), (100, 50)]}]

    # First sighting: no prior point yet, can't detect a crossing.
    fired_first = intrusion.check_and_process(10, (10, 10, 30, 30), _fake_frame())  # center (20,20), above the line
    check("first sighting (no prior point) never fires", fired_first is False and len(calls) == 0, f"calls={calls}")

    # Second sighting: center moves from y=20 to y=80, crossing the y=50 line.
    fired_second = intrusion.check_and_process(10, (10, 70, 30, 90), _fake_frame())  # center (20,80)
    check("crossing the line on the next sighting fires", fired_second is True)
    check("fires exactly: intrusion + unique_persons + mqtt", len(calls) == 3, f"calls={calls}")


if __name__ == '__main__':
    test_load_time_ranges_from_env()
    test_load_lines_from_env()
    test_is_time_active_no_ranges_configured()
    test_is_time_active_non_wrapping_range()
    test_is_time_active_wrapping_range()
    test_is_time_active_multiple_ranges()
    test_intrusion_dedup_zone_mode()
    test_intrusion_time_gate_suppresses_zone_hit()
    test_intrusion_line_crossing_mode()
    finish()
