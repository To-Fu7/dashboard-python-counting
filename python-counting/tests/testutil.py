"""Shared harness for the plain-script test files.

Importing this module (before any app module) bootstraps sys.path and the
minimal env vars counting_config needs, and provides the check()/finish()
pass-fail counter used by every test file.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault('SCREEN_RESOLUTION', '[800, 600]')
os.environ.setdefault('lineA', '[(0,0),(10,10)]')
os.environ.setdefault('DEBUG_MODE', 'true')

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name} {detail}")


def finish():
    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)
