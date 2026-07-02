"""Decode YOLO outputs from Triton into detections in original-frame coordinates.

Two output layouts are supported (auto-detected from the tensor shape):

1. End-to-end / NMS-embedded export (YOLO26 native, or YOLO11 exported with
   nms=True): shape [batch, max_det, 6] rows = x1,y1,x2,y2,conf,cls in
   letterboxed-input pixels. Nothing to do but filter.
2. Raw detection head: shape [batch, 4+nc, anchors] — decode xywh + class
   scores, then run numpy NMS (fallback for models where the NMS ops fail to
   convert to TensorRT).

Both paths finish with unletterbox(): (xy - pad) / ratio, the inverse of
preprocessing.letterbox, clipped to the frame — after which coordinates match
what the legacy ultralytics pipeline reported for the detection_frame.
"""
from __future__ import annotations

import numpy as np


def is_end_to_end(output_shape: tuple[int, ...]) -> bool:
    """e2e output ends in 6 (x1,y1,x2,y2,conf,cls); a raw head ends in the anchor
    count (e.g. 8400), never 6. Robust whether or not the batch axis is present —
    Triton model metadata may report [-1, 300, 6], [300, 6], or [1, 300, 6]."""
    return output_shape[-1] == 6


def nms_numpy(boxes_xyxy: np.ndarray, scores: np.ndarray, iou_thresh: float) -> np.ndarray:
    """Plain greedy NMS. Returns indices of kept boxes, highest score first."""
    if len(boxes_xyxy) == 0:
        return np.zeros(0, dtype=np.int64)
    x1, y1, x2, y2 = boxes_xyxy.T
    areas = (x2 - x1).clip(0) * (y2 - y1).clip(0)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = (xx2 - xx1).clip(0) * (yy2 - yy1).clip(0)
        iou = inter / (areas[i] + areas[order[1:]] - inter + 1e-7)
        order = order[1:][iou <= iou_thresh]
    return np.asarray(keep, dtype=np.int64)


def decode_e2e(output: np.ndarray, conf_thresh: float, class_id: int | None = 0) -> np.ndarray:
    """Decode [max_det, 6] e2e output -> [N, 6] (x1,y1,x2,y2,conf,cls)."""
    dets = output.reshape(-1, 6)
    mask = dets[:, 4] >= conf_thresh
    if class_id is not None:
        mask &= dets[:, 5].astype(np.int64) == class_id
    return dets[mask]


def decode_raw(
    output: np.ndarray,
    conf_thresh: float,
    iou_thresh: float = 0.3,
    class_id: int | None = 0,
    max_det: int = 300,
) -> np.ndarray:
    """Decode raw head [4+nc, anchors] -> NMS -> [N, 6] (x1,y1,x2,y2,conf,cls)."""
    pred = output.reshape(output.shape[-2], output.shape[-1])  # [4+nc, anchors]
    boxes_xywh = pred[:4].T                     # [anchors, 4] cx,cy,w,h (input pixels)
    class_scores = pred[4:].T                   # [anchors, nc]
    cls = class_scores.argmax(axis=1)
    conf = class_scores.max(axis=1)

    mask = conf >= conf_thresh
    if class_id is not None:
        mask &= cls == class_id
    boxes_xywh, conf, cls = boxes_xywh[mask], conf[mask], cls[mask]
    if len(conf) == 0:
        return np.zeros((0, 6), dtype=np.float32)

    xy, wh = boxes_xywh[:, :2], boxes_xywh[:, 2:]
    boxes_xyxy = np.concatenate([xy - wh / 2, xy + wh / 2], axis=1)

    keep = nms_numpy(boxes_xyxy, conf, iou_thresh)[:max_det]
    return np.concatenate(
        [boxes_xyxy[keep], conf[keep, None], cls[keep, None].astype(np.float32)], axis=1
    ).astype(np.float32)


def unletterbox(
    dets: np.ndarray,
    ratio: float,
    pad: tuple[float, float],
    frame_shape: tuple[int, int],
) -> np.ndarray:
    """Map detection boxes from letterboxed-input pixels back to frame pixels."""
    if len(dets) == 0:
        return dets
    dets = dets.copy()
    dw, dh = pad
    dets[:, [0, 2]] = (dets[:, [0, 2]] - dw) / ratio
    dets[:, [1, 3]] = (dets[:, [1, 3]] - dh) / ratio
    h, w = frame_shape[:2]
    dets[:, [0, 2]] = dets[:, [0, 2]].clip(0, w)
    dets[:, [1, 3]] = dets[:, [1, 3]].clip(0, h)
    return dets
