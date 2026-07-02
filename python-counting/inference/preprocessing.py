"""YOLO input preprocessing without ultralytics/torch.

letterbox() replicates ultralytics.data.augment.LetterBox with auto=False and
center=True — the exact transform the legacy pipeline applied when running a
fixed-shape TensorRT engine. Keeping it bit-identical matters: the inverse
mapping in postprocessing must land boxes on the same pixels the old system saw.
"""
from __future__ import annotations

import cv2
import numpy as np


def letterbox(
    img: np.ndarray,
    new_shape: tuple[int, int] = (640, 640),
    color: tuple[int, int, int] = (114, 114, 114),
    scaleup: bool = True,
) -> tuple[np.ndarray, float, tuple[float, float]]:
    """Resize and pad image to new_shape (h, w) preserving aspect ratio.

    Returns (padded_image, ratio, (dw, dh)) where dw/dh are the per-side pads.
    """
    shape = img.shape[:2]  # current shape [height, width]
    if isinstance(new_shape, int):
        new_shape = (new_shape, new_shape)

    r = min(new_shape[0] / shape[0], new_shape[1] / shape[1])
    if not scaleup:  # only scale down (better mAP for val); predict uses scaleup
        r = min(r, 1.0)

    new_unpad = int(round(shape[1] * r)), int(round(shape[0] * r))
    dw, dh = new_shape[1] - new_unpad[0], new_shape[0] - new_unpad[1]  # wh padding
    dw /= 2  # divide padding into 2 sides (center=True)
    dh /= 2

    if shape[::-1] != new_unpad:  # resize
        img = cv2.resize(img, new_unpad, interpolation=cv2.INTER_LINEAR)
    top, bottom = int(round(dh - 0.1)), int(round(dh + 0.1))
    left, right = int(round(dw - 0.1)), int(round(dw + 0.1))
    img = cv2.copyMakeBorder(img, top, bottom, left, right, cv2.BORDER_CONSTANT, value=color)
    return img, r, (dw, dh)


def preprocess(
    frame_bgr: np.ndarray,
    input_shape: tuple[int, int],
    dtype: np.dtype = np.float32,
) -> tuple[np.ndarray, float, tuple[float, float]]:
    """BGR frame -> normalized NCHW tensor ready for Triton.

    Returns (tensor[1,3,H,W], ratio, (dw, dh)) for coordinate un-mapping.
    """
    padded, ratio, pad = letterbox(frame_bgr, input_shape)
    rgb = cv2.cvtColor(padded, cv2.COLOR_BGR2RGB)
    tensor = rgb.astype(np.float32) / 255.0
    tensor = np.ascontiguousarray(tensor.transpose(2, 0, 1)[None], dtype=dtype)
    return tensor, ratio, pad
