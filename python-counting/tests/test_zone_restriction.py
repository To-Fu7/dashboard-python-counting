"""Unit tests for APD/Face restriction zones: the point-in-zone helper
(main.py._center_in_any_zone), the generic zone loader (counting_config.
load_zones_from_env), and the fallback resolution rule (own zone > inherited
person zone when DETECTION_MODE='zone' > unrestricted). The fallback rule
depends on module-level constants computed at import time from env vars, so
that part runs in a subprocess per scenario — importing counting_config twice
in one process would just reuse the first import's already-computed values.

Run from python-counting/:  python tests/test_zone_restriction.py
"""
import os
import subprocess
import sys

from testutil import check, finish  # bootstraps sys.path + base env vars

import numpy as np


def test_center_in_any_zone():
    print("[1] _center_in_any_zone (point-in-polygon helper)")
    import main

    square = {'polygon': np.array([[0, 0], [100, 0], [100, 100], [0, 100]], dtype=np.float32)}

    check("empty zone list means unrestricted (always True)",
          main._center_in_any_zone(9999, 9999, []) is True)
    check("point inside the polygon matches", main._center_in_any_zone(50, 50, [square]) is True)
    check("point outside the polygon does not match", main._center_in_any_zone(500, 500, [square]) is False)

    other = {'polygon': np.array([[200, 200], [300, 200], [300, 300], [200, 300]], dtype=np.float32)}
    check("point matches the second of two zones", main._center_in_any_zone(250, 250, [square, other]) is True)


def test_load_zones_from_env_prefix():
    print("[2] load_zones_from_env respects prefix (apdZone vs faceZone vs zone)")
    import counting_config as cfg

    os.environ['apdZoneA'] = '[(0,0),(10,0),(10,10)]'
    os.environ['faceZoneA'] = '[(20,20),(30,20),(30,30)]'
    try:
        apd_zones = cfg.load_zones_from_env(prefix='apdZone')
        face_zones = cfg.load_zones_from_env(prefix='faceZone')
        check("apdZone prefix loads only the APD zone", len(apd_zones) == 1 and apd_zones[0]['name'] == 'apdZoneA')
        check("faceZone prefix loads only the Face zone", len(face_zones) == 1 and face_zones[0]['name'] == 'faceZoneA')
        check("zones from different prefixes don't leak into each other",
              not np.array_equal(apd_zones[0]['polygon'], face_zones[0]['polygon']))
    finally:
        del os.environ['apdZoneA']
        del os.environ['faceZoneA']


def _run_subprocess_scenario(extra_env):
    """Import counting_config fresh in a subprocess with the given env vars
    layered on the base test env, and report what APD/FACE_EFFECTIVE_ZONES
    resolved to. Fresh process = module-level constants are recomputed from
    scratch, unlike re-importing in this same process."""
    env = os.environ.copy()
    env.update({
        'SCREEN_RESOLUTION': '[800, 600]',
        'lineA': '[(0,0),(10,10)]',
        'DEBUG_MODE': 'true',
    })
    env.update(extra_env)
    script = (
        "import counting_config as cfg; "
        "print('APD_EFFECTIVE=' + str(len(cfg.APD_EFFECTIVE_ZONES))); "
        "print('FACE_EFFECTIVE=' + str(len(cfg.FACE_EFFECTIVE_ZONES)))"
    )
    result = subprocess.run(
        [sys.executable, '-c', script],
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        env=env, capture_output=True, text=True, timeout=30,
    )
    return result.stdout


def test_fallback_resolution_line_crossing_unrestricted():
    print("[3] line_crossing mode, no own zone -> unrestricted (0 effective zones)")
    out = _run_subprocess_scenario({'DETECTION_MODE': 'line_crossing'})
    check("APD unrestricted in line_crossing with no apdZone*", 'APD_EFFECTIVE=0' in out, out)
    check("Face unrestricted in line_crossing with no faceZone*", 'FACE_EFFECTIVE=0' in out, out)


def test_fallback_resolution_line_crossing_with_own_zone():
    print("[4] line_crossing mode, own zone set -> that zone is used")
    out = _run_subprocess_scenario({
        'DETECTION_MODE': 'line_crossing',
        'apdZoneA': '[(0,0),(10,0),(10,10)]',
    })
    check("APD uses its own zone even in line_crossing mode", 'APD_EFFECTIVE=1' in out, out)
    check("Face still unrestricted (no faceZone* set)", 'FACE_EFFECTIVE=0' in out, out)


def test_fallback_resolution_zone_mode_inherits_person_zones():
    print("[5] zone mode, no own zone -> inherits the person-counting zones")
    out = _run_subprocess_scenario({
        'DETECTION_MODE': 'zone',
        'zoneA': '[(0,0),(100,0),(100,100)]',
    })
    check("APD inherits the person zone when DETECTION_MODE=zone", 'APD_EFFECTIVE=1' in out, out)
    check("Face inherits the person zone when DETECTION_MODE=zone", 'FACE_EFFECTIVE=1' in out, out)


def test_fallback_resolution_zone_mode_own_zone_wins():
    print("[6] zone mode, own zone set -> own zone wins over the inherited one")
    out = _run_subprocess_scenario({
        'DETECTION_MODE': 'zone',
        'zoneA': '[(0,0),(100,0),(100,100)]',
        'faceZoneA': '[(0,0),(10,0),(10,10)]',
        'faceZoneB': '[(20,20),(30,20),(30,30)]',
    })
    check("Face's own 2 zones win over the single inherited person zone", 'FACE_EFFECTIVE=2' in out, out)
    check("APD still inherits the person zone (no apdZone* set)", 'APD_EFFECTIVE=1' in out, out)


if __name__ == '__main__':
    test_center_in_any_zone()
    test_load_zones_from_env_prefix()
    test_fallback_resolution_line_crossing_unrestricted()
    test_fallback_resolution_line_crossing_with_own_zone()
    test_fallback_resolution_zone_mode_inherits_person_zones()
    test_fallback_resolution_zone_mode_own_zone_wins()
    finish()
