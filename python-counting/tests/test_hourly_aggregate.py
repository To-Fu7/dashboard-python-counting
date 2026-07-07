"""Unit tests for outputs.hourly_aggregate_db — pure call-shape assertions,
no real Postgres needed (db_query/db_queue_write are monkeypatched to record
invocations, matching the style of tests/test_detection_events.py).

Run from python-counting/:  python tests/test_hourly_aggregate.py
"""
import datetime

from testutil import check, finish  # bootstraps sys.path + base env vars

import counting_config as cfg
from outputs import hourly_aggregate_db as had


def test_increment_hourly_valid_table():
    print("[1] increment_hourly — valid table")
    calls = []
    had.db_queue_write = lambda query, params: calls.append((query, params))

    hour = datetime.datetime.now(cfg.local_tz).replace(minute=0, second=0, microsecond=0)
    had.increment_hourly('apd_hourly', 'dev-1', 'CODE1', 'Cam One', hour, 'no_helmet')

    check("exactly one query queued", len(calls) == 1, f"calls={calls}")
    query, params = calls[0]
    check("query targets apd_hourly", 'apd_hourly' in query, query)
    check("query has ON CONFLICT upsert", 'ON CONFLICT' in query, query)
    check("label appears 3 times as a bound param (build, path, lookup)",
          params.count('no_helmet') == 3, f"params={params}")
    check("no other table name leaked into the query", 'firesmoke_hourly' not in query, query)


def test_increment_hourly_rejects_unknown_table():
    print("[2] increment_hourly — unknown table is rejected, not queried")
    calls = []
    had.db_queue_write = lambda query, params: calls.append((query, params))

    had.increment_hourly('not_a_real_table', 'dev-1', 'CODE1', 'Cam One',
                          datetime.datetime.now(cfg.local_tz), 'x')
    check("no query queued for an unknown table", len(calls) == 0, f"calls={calls}")


def test_pregenerate_day_valid_table():
    print("[3] pregenerate_day — valid table")
    calls = []
    had.db_query = lambda query, params, commit=False: calls.append((query, params, commit))

    day_start = datetime.datetime.now(cfg.local_tz).replace(hour=0, minute=0, second=0, microsecond=0)
    had.pregenerate_day('firesmoke_hourly', 'dev-1', 'CODE1', 'Cam One', day_start)

    check("exactly one query executed", len(calls) == 1, f"calls={calls}")
    query, params, commit = calls[0]
    check("query targets firesmoke_hourly", 'firesmoke_hourly' in query, query)
    check("query generates 24 hours via generate_series(0, 23)",
          'generate_series(0, 23)' in query, query)
    check("query is ON CONFLICT DO NOTHING (never clobbers existing counts)",
          'DO NOTHING' in query, query)
    check("commit=True (synchronous, not the async queue)", commit is True)
    check("day_start passed through as the 4th positional param",
          params[3] == day_start, f"params={params}")


def test_pregenerate_day_rejects_unknown_table():
    print("[4] pregenerate_day — unknown table is rejected, not queried")
    calls = []
    had.db_query = lambda query, params, commit=False: calls.append((query, params, commit))

    had.pregenerate_day('not_a_real_table', 'dev-1', 'CODE1', 'Cam One',
                         datetime.datetime.now(cfg.local_tz))
    check("no query executed for an unknown table", len(calls) == 0, f"calls={calls}")


if __name__ == '__main__':
    test_increment_hourly_valid_table()
    test_increment_hourly_rejects_unknown_table()
    test_pregenerate_day_valid_table()
    test_pregenerate_day_rejects_unknown_table()
    finish()
