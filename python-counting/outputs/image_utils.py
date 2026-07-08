"""Cropping helper for MQTT event images — ported from the legacy main.py
(crop_image), which was dropped during the Triton migration. Used by the
person-counting line-crossing events (counting.py) and APD violation events
(detection/apd.py).
"""
import cv2

import counting_config as cfg


def crop_image(frame, box, padding=None):
    """Crop image around a detection box with padding, upscaling if too small.

    box: (x1, y1, x2, y2) in the frame's own coordinate system.
    """
    if padding is None:
        padding = cfg.CROP_PADDING

    x1, y1, x2, y2 = box
    h, w = frame.shape[:2]

    x1_crop = max(0, x1 - padding)
    y1_crop = max(0, y1 - padding)
    x2_crop = min(w, x2 + padding)
    y2_crop = min(h, y2 + padding)

    person_crop = frame[y1_crop:y2_crop, x1_crop:x2_crop]

    crop_h, crop_w = person_crop.shape[:2]
    if crop_h == 0 or crop_w == 0:
        return person_crop
    if crop_h < cfg.MIN_CROP_SIZE[1] or crop_w < cfg.MIN_CROP_SIZE[0]:
        aspect_ratio = crop_w / crop_h
        if aspect_ratio > 1:
            new_w = max(cfg.MIN_CROP_SIZE[0], crop_w)
            new_h = int(new_w / aspect_ratio)
            if new_h < cfg.MIN_CROP_SIZE[1]:
                new_h = cfg.MIN_CROP_SIZE[1]
                new_w = int(new_h * aspect_ratio)
        else:
            new_h = max(cfg.MIN_CROP_SIZE[1], crop_h)
            new_w = int(new_h * aspect_ratio)
            if new_w < cfg.MIN_CROP_SIZE[0]:
                new_w = cfg.MIN_CROP_SIZE[0]
                new_h = int(new_w / aspect_ratio)
        person_crop = cv2.resize(person_crop, (new_w, new_h), interpolation=cv2.INTER_LANCZOS4)

    return person_crop


def crop_face(frame, box, margin=0.25, min_size=112):
    """'Zoom' a detected face before embedding: expand the bbox by a
    proportional margin (ArcFace expects some context around the face, and
    tracker boxes are often tighter than the training crop), then upscale
    tiny CCTV faces so the embedder's downstream 112x112 resize starts from
    a cleanly interpolated image instead of a handful of raw pixels.

    box: (x1, y1, x2, y2) in the frame's own coordinate system.
    Returns an empty array if the box is degenerate."""
    x1, y1, x2, y2 = box
    h, w = frame.shape[:2]

    mx = int((x2 - x1) * margin)
    my = int((y2 - y1) * margin)
    x1_crop = max(0, x1 - mx)
    y1_crop = max(0, y1 - my)
    x2_crop = min(w, x2 + mx)
    y2_crop = min(h, y2 + my)

    face = frame[y1_crop:y2_crop, x1_crop:x2_crop]
    crop_h, crop_w = face.shape[:2]
    if crop_h == 0 or crop_w == 0:
        return face

    shortest = min(crop_h, crop_w)
    if shortest < min_size:
        scale = min_size / shortest
        face = cv2.resize(face, (round(crop_w * scale), round(crop_h * scale)),
                          interpolation=cv2.INTER_CUBIC)
    return face
