"""In-memory known_faces cache + cosine-similarity matching.

Loaded once at startup and refreshed on a background timer (FACE_CACHE_REFRESH_MINUTES,
not per-frame/per-detection) — bounded, predictable DB load with a known worst-case
staleness window for new enrollments. A person can have multiple rows (one per
augmented variant); matching compares against every stored row and takes the best
cosine similarity, not an average.
"""
import logging
import threading

import numpy as np

import counting_config as cfg
from outputs.db_worker import db_fetch_all

_cache_lock = threading.Lock()
_names: list[str] = []
_embeddings: np.ndarray | None = None  # shape (N, D), L2-normalized rows
_refresh_timer: threading.Timer | None = None


def _l2_normalize(mat: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return mat / norms


def refresh_cache():
    """Reload the full known_faces table into memory. Safe to call repeatedly
    (e.g. from a background timer) — replaces the cache atomically under lock."""
    rows = db_fetch_all("SELECT person_name, embedding FROM known_faces", ())

    names = [row[0] for row in rows]
    if rows:
        embeddings = _l2_normalize(np.array([row[1] for row in rows], dtype=np.float32))
    else:
        embeddings = np.zeros((0, 0), dtype=np.float32)

    with _cache_lock:
        global _names, _embeddings
        _names = names
        _embeddings = embeddings

    logging.info(f"Face cache refreshed: {len(names)} embedding row(s), {len(set(names))} unique person(s)")


def start_cache_refresh_loop():
    """Load the cache immediately, then schedule periodic refreshes every
    FACE_CACHE_REFRESH_MINUTES on a daemon timer thread."""
    refresh_cache()

    def _tick():
        refresh_cache()
        _schedule_next()

    def _schedule_next():
        global _refresh_timer
        _refresh_timer = threading.Timer(cfg.FACE_CACHE_REFRESH_MINUTES * 60, _tick)
        _refresh_timer.daemon = True
        _refresh_timer.start()

    _schedule_next()


def match(embedding: np.ndarray, threshold: float = None):
    """Return (person_name, similarity) for the best cosine-similarity match
    across every cached embedding row, or (None, similarity) if the best
    match is below threshold (default cfg.FACE_MATCH_THRESHOLD) — the caller
    treats None as 'intruder'. similarity is -1.0 if the cache is empty."""
    if threshold is None:
        threshold = cfg.FACE_MATCH_THRESHOLD

    with _cache_lock:
        names, embeddings = _names, _embeddings

    if embeddings is None or len(names) == 0:
        return None, -1.0

    query = embedding / (np.linalg.norm(embedding) or 1.0)
    similarities = embeddings @ query
    best_idx = int(np.argmax(similarities))
    best_similarity = float(similarities[best_idx])

    if best_similarity >= threshold:
        return names[best_idx], best_similarity
    return None, best_similarity
