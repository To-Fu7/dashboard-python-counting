"""Unit tests for face recognition: per-track dedup (detection/face.py) and
cosine-similarity matching against the in-memory cache (outputs/face_db.py).
Pure logic tests — no Triton/DB/MQTT connection needed (those calls are
monkeypatched to record invocations or preloaded directly into the cache).

Run from python-counting/:  python tests/test_face_detection.py
"""
from testutil import check, finish  # bootstraps sys.path + base env vars

import os

os.environ.setdefault('INSIDER_TAG', 'info')
os.environ.setdefault('INTRUDER_TAG', 'alarm')

import numpy as np


def _fake_frame():
    return np.zeros((100, 100, 3), dtype=np.uint8)


def test_face_dedup():
    print("[1] Face per-track dedup (one verdict per track, ever)")
    import app_state as state
    from detection import face

    calls = []
    face.increment_hourly = lambda *a, **k: calls.append(('hourly', a))
    face.send_detection_event_mqtt = lambda *a, **k: calls.append(('mqtt', a))

    state.face_alerted_tracks.clear()

    # First sighting of track 3: label increment + unique_persons increment + mqtt = 3
    face.process_detection(3, 'Jane', 'info', 0.82, (0, 0, 10, 10), _fake_frame())
    check("first verdict for a new track fires label + unique_persons + mqtt",
          len(calls) == 3, f"calls={calls}")

    # Same track again (even with a different verdict) is suppressed — one
    # verdict per track for its whole lifetime, not one per hour.
    calls.clear()
    face.process_detection(3, 'intruder', 'alarm', 0.1, (0, 0, 10, 10), _fake_frame())
    check("repeat sighting of the same track is suppressed", len(calls) == 0, f"calls={calls}")

    # A different track fires independently.
    calls.clear()
    face.process_detection(4, 'intruder', 'alarm', 0.2, (0, 0, 10, 10), _fake_frame())
    check("a different track still fires its own verdict",
          len(calls) == 3, f"calls={calls}")


def test_face_matching():
    print("[2] Cosine-similarity matching against the known_faces cache")
    from outputs import face_db

    # Directly seed the in-memory cache (bypassing DB) with two people, two
    # variant rows for Jane (matching should pick the BEST similarity across
    # variants, not an average).
    with face_db._cache_lock:
        face_db._names = ['Jane', 'Jane', 'Bob']
        face_db._embeddings = face_db._l2_normalize(np.array([
            [1.0, 0.0, 0.0],
            [0.9, 0.1, 0.0],
            [0.0, 1.0, 0.0],
        ], dtype=np.float32))

    name, similarity = face_db.match(np.array([1.0, 0.0, 0.0]), threshold=0.5)
    check("exact match returns the right person", name == 'Jane', f"name={name}")
    check("similarity is ~1.0 for an exact match", similarity > 0.99, f"similarity={similarity}")

    name, similarity = face_db.match(np.array([0.0, 1.0, 0.0]), threshold=0.5)
    check("a different embedding matches the other person", name == 'Bob', f"name={name}")

    name, similarity = face_db.match(np.array([0.0, 0.0, 1.0]), threshold=0.5)
    check("an embedding below threshold returns no match (intruder)", name is None, f"name={name}")
    check("similarity is still returned even without a match", similarity < 0.5, f"similarity={similarity}")


def test_face_matching_empty_cache():
    print("[3] Matching against an empty cache")
    from outputs import face_db

    with face_db._cache_lock:
        face_db._names = []
        face_db._embeddings = np.zeros((0, 0), dtype=np.float32)

    name, similarity = face_db.match(np.array([1.0, 0.0, 0.0]))
    check("empty cache never matches", name is None, f"name={name}")
    check("empty cache reports a sentinel -1.0 similarity", similarity == -1.0, f"similarity={similarity}")


if __name__ == '__main__':
    test_face_dedup()
    test_face_matching()
    test_face_matching_empty_cache()
    finish()
