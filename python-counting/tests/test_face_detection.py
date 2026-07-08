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
    face.process_detection(3, 'Jane', 'info', 0.82, _fake_frame())
    check("first verdict for a new track fires label + unique_persons + mqtt",
          len(calls) == 3, f"calls={calls}")

    # Same track again (even with a different verdict) is suppressed — one
    # verdict per track for its whole lifetime, not one per hour.
    calls.clear()
    face.process_detection(3, 'intruder', 'alarm', 0.1, _fake_frame())
    check("repeat sighting of the same track is suppressed", len(calls) == 0, f"calls={calls}")

    # A different track fires independently.
    calls.clear()
    face.process_detection(4, 'intruder', 'alarm', 0.2, _fake_frame())
    check("a different track still fires its own verdict",
          len(calls) == 3, f"calls={calls}")


def test_best_shot_selection():
    print("[4] Best-shot: buffers sightings, commits to the highest-quality one")
    from detection import face

    candidates = []
    # Frames 1-4: still gathering (capture_frames=5) — returns None each time.
    for i in range(4):
        result = face.collect_best_shot(candidates, quality=i / 10.0, crop=f'crop{i}', box=(i, i, i, i), capture_frames=5)
        check(f"still gathering after sighting {i + 1}/5", result is None, f"result={result}")

    # 5th sighting has the HIGHEST quality of the batch (not the last one, not
    # the first) — the point of best-shot is picking the best regardless of order.
    result = face.collect_best_shot(candidates, quality=0.99, crop='best_crop', box=(9, 9, 9, 9), capture_frames=5)
    check("5th sighting triggers a decision", result is not None, f"result={result}")
    quality, crop, box = result
    check("the highest-quality sighting is selected, not the most recent one",
          crop == 'best_crop' and quality == 0.99, f"selected={result}")

    # A mid-batch sighting can also win if its quality is highest.
    candidates2 = []
    qualities = [0.3, 0.8, 0.2, 0.1, 0.05]
    for i, q in enumerate(qualities):
        result = face.collect_best_shot(candidates2, quality=q, crop=f'crop{i}', box=(0, 0, 0, 0), capture_frames=5)
    check("a mid-batch sighting wins when it has the highest quality",
          result[1] == 'crop1', f"selected={result}")


def test_quality_score_signals():
    print("[5] compute_quality_score favors bigger/sharper/higher-confidence sightings")
    from detection import face

    small_blurry = np.full((40, 40, 3), 128, dtype=np.uint8)  # flat gray = zero sharpness
    big_sharp = (np.random.default_rng(0).random((160, 160, 3)) * 255).astype(np.uint8)  # noisy = high edge energy

    score_small = face.compute_quality_score(small_blurry, box_w=40, box_h=40, det_confidence=0.3)
    score_big = face.compute_quality_score(big_sharp, box_w=160, box_h=160, det_confidence=0.3)
    check("a bigger, sharper crop scores higher than a small flat one", score_big > score_small,
          f"small={score_small:.3f} big={score_big:.3f}")

    same_crop = np.full((100, 100, 3), 128, dtype=np.uint8)
    score_low_conf = face.compute_quality_score(same_crop, box_w=100, box_h=100, det_confidence=0.2)
    score_high_conf = face.compute_quality_score(same_crop, box_w=100, box_h=100, det_confidence=0.9)
    check("higher detector confidence scores higher, all else equal",
          score_high_conf > score_low_conf, f"low={score_low_conf:.3f} high={score_high_conf:.3f}")

    dark_crop = np.full((100, 100, 3), 5, dtype=np.uint8)     # near-black
    mid_crop = np.full((100, 100, 3), 130, dtype=np.uint8)    # comfortable mid-tone
    score_dark = face.compute_quality_score(dark_crop, box_w=100, box_h=100, det_confidence=0.5)
    score_mid = face.compute_quality_score(mid_crop, box_w=100, box_h=100, det_confidence=0.5)
    check("a well-lit mid-tone crop scores higher than a near-black one",
          score_mid > score_dark, f"dark={score_dark:.3f} mid={score_mid:.3f}")


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
    test_best_shot_selection()
    test_quality_score_signals()
    finish()
