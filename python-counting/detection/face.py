"""Face detection/recognition: per-track dedup — a track_id fires at most one
event (insider-with-name or intruder) for the life of that track, the first
time it's classified. Unlike APD (which dedups per label), a face track only
ever needs one verdict, so state.face_alerted_tracks is a plain set.

Best-shot selection (compute_quality_score / collect_best_shot): rather than
embedding whatever frame a track is FIRST seen in — which might be a bad
angle on an oblique/overhead CCTV camera — a few sightings are buffered per
track and the highest-quality one is embedded/matched. Same principle
commercial face-capture cameras (e.g. Hikvision's "best shot" feature) use:
score each sighting by face size, sharpness, and detector confidence, then
commit to the best one instead of the first one. We don't score pose (no
landmark output from our detector) or occlusion (no skin-tone segmentation) —
just the three cheap-to-compute signals available from a plain bbox + crop.

Matching (cosine similarity vs the in-memory known_faces cache) happens
upstream in main.py, which passes the resolved label/tag/similarity here —
same responsibility split as apd.py (main.py owns the Triton/tracker wiring,
this module owns best-shot scoring + dedup + the hourly-aggregate/MQTT write
path).

Writes go to face_hourly (one row per hour, JSONB counters keyed by person
name or "intruder", plus unique_persons) rather than a per-event table. Since
a track fires at most once ever, every fired event is by definition a new
unique person for that hour — no separate per-hour tracking is needed here
(contrast with APD, where a single track can trigger multiple distinct
label events).
"""
import logging

import cv2

import app_state as state
import counting_config as cfg
from outputs.hourly_aggregate_db import increment_hourly
from outputs.mqtt_out import send_detection_event_mqtt


def compute_quality_score(crop, box_w, box_h, det_confidence):
    """Heuristic 'is this a good frame to embed' score for one sighting of a
    face track, roughly following the size/sharpness/illumination/confidence
    factors described for commercial best-shot systems:
    - size: bigger faces carry more resolvable detail (capped — a face
      filling the whole crop isn't 10x better than one at 200px).
    - sharpness: Laplacian variance of the gray crop — a classic focus/motion
      blur proxy (blurry = low edge energy = low variance).
    - detector confidence: the face model's own confidence for this box,
      already correlates with how face-like/frontal the detection looked.
    - brightness: a mild penalty outside a comfortable ~60-200 mid-tone band
      (too dark/blown-out crops embed poorly regardless of sharpness)."""
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    sharpness = cv2.Laplacian(gray, cv2.CV_64F).var()
    brightness = float(gray.mean())
    brightness_penalty = 0.0 if 60.0 <= brightness <= 200.0 else abs(brightness - 130.0) / 130.0

    size_component = min(min(box_w, box_h), 200) / 200.0
    sharpness_component = min(sharpness, 500.0) / 500.0

    return (0.4 * size_component + 0.3 * sharpness_component + 0.3 * det_confidence) - 0.1 * brightness_penalty


def collect_best_shot(candidates, quality, crop, box, capture_frames):
    """Append one (quality, crop, box) observation to a track's running
    candidate list. Once `capture_frames` observations have been collected,
    return the highest-quality one and the caller should stop collecting for
    that track (pop it from wherever `candidates` came from); otherwise
    return None to mean 'still gathering'.

    candidates is mutated in place (it's expected to be
    app_state.face_candidates[track_id], a plain list)."""
    candidates.append((quality, crop, box))
    if len(candidates) < capture_frames:
        return None
    return max(candidates, key=lambda c: c[0])


def process_detection(track_id, label, tag, similarity, crop):
    """label: matched person_name, or "intruder" if no match. crop: the
    best-shot face image already selected by collect_best_shot (not re-cropped
    here — the whole point of best-shot is to use that specific frame's image,
    not whatever frame happens to be current when the verdict is committed)."""
    if track_id in state.face_alerted_tracks:
        return
    state.face_alerted_tracks.add(track_id)

    logging.info(f"Face event: track {track_id} label={label} similarity={similarity:.2f}")

    increment_hourly('face_hourly', cfg.device_id, cfg.device_code, cfg.device_name,
                      state.current_tracking_hour, label)
    increment_hourly('face_hourly', cfg.device_id, cfg.device_code, cfg.device_name,
                      state.current_tracking_hour, 'unique_persons')

    send_detection_event_mqtt(crop, 'face', tag, label, similarity,
                               track_id=track_id, topic=cfg.MQTT_FACE_TOPIC)
