"""Unit tests for SCREEN_RESOLUTION='auto' support: config parsing
(counting_config.AUTO_RESOLUTION/resolution) runs in a subprocess per
scenario since they're module-level constants computed at import time —
importing counting_config twice in one process just reuses the first
import's already-computed values (see test_zone_restriction.py for the same
pattern).

Run from python-counting/:  python tests/test_auto_resolution.py
"""
import os
import subprocess
import sys

from testutil import check, finish  # bootstraps sys.path + base env vars


def _resolution_config_in_subprocess(screen_resolution):
    env = os.environ.copy()
    env.update({
        'SCREEN_RESOLUTION': screen_resolution,
        'lineA': '[(0,0),(10,10)]',
        'DEBUG_MODE': 'true',
    })
    script = (
        "import counting_config as cfg; "
        "print('AUTO=' + str(cfg.AUTO_RESOLUTION)); "
        "print('RES=' + str(cfg.resolution))"
    )
    result = subprocess.run(
        [sys.executable, '-c', script],
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        env=env, capture_output=True, text=True, timeout=30,
    )
    return result.stdout


def test_fixed_resolution_unchanged():
    print("[1] SCREEN_RESOLUTION='[1920, 1080]' behaves exactly as before")
    out = _resolution_config_in_subprocess('[1920, 1080]')
    check("AUTO_RESOLUTION is False for a fixed resolution", 'AUTO=False' in out, out)
    check("resolution parses to the configured pixel size", 'RES=[1920, 1080]' in out, out)


def test_auto_resolution_lowercase():
    print("[2] SCREEN_RESOLUTION='auto' sets AUTO_RESOLUTION, resolution=None")
    out = _resolution_config_in_subprocess('auto')
    check("AUTO_RESOLUTION is True", 'AUTO=True' in out, out)
    check("resolution is None (no fixed target — native frame size used instead)",
          'RES=None' in out, out)


def test_auto_resolution_case_insensitive():
    print("[3] SCREEN_RESOLUTION='Auto'/'AUTO' also work (case-insensitive)")
    for variant in ('Auto', 'AUTO', '  auto  '):
        out = _resolution_config_in_subprocess(variant)
        check(f"AUTO_RESOLUTION is True for {variant!r}", 'AUTO=True' in out, out)


if __name__ == '__main__':
    test_fixed_resolution_unchanged()
    test_auto_resolution_lowercase()
    test_auto_resolution_case_insensitive()
    finish()
