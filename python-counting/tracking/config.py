"""ByteTrack configuration and detection container.

BYTETrackerArgs mirrors ultralytics/cfg/trackers/bytetrack.yaml defaults exactly —
these are the parameters the legacy main.py ran with via tracker="bytetrack.yaml".

Detections mimics the subset of the ultralytics Boxes API that BYTETracker.update()
consumes (.conf, .cls, .xywh, .xyxy, len(), boolean-mask indexing).
"""
from dataclasses import dataclass

import numpy as np


@dataclass
class BYTETrackerArgs:
    tracker_type: str = "bytetrack"
    track_high_thresh: float = 0.25
    track_low_thresh: float = 0.1
    new_track_thresh: float = 0.25
    track_buffer: int = 30
    match_thresh: float = 0.8
    fuse_score: bool = True


class Detections:
    """Numpy detection batch in xyxy+conf+cls layout, indexable like ultralytics Boxes."""

    def __init__(self, xyxy: np.ndarray, conf: np.ndarray, cls: np.ndarray):
        self.xyxy = np.asarray(xyxy, dtype=np.float32).reshape(-1, 4)
        self.conf = np.asarray(conf, dtype=np.float32).reshape(-1)
        self.cls = np.asarray(cls, dtype=np.float32).reshape(-1)

    @property
    def xywh(self) -> np.ndarray:
        x1, y1, x2, y2 = self.xyxy.T
        return np.stack([(x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1], axis=1)

    def __len__(self) -> int:
        return len(self.conf)

    def __getitem__(self, idx) -> "Detections":
        return Detections(self.xyxy[idx], self.conf[idx], self.cls[idx])

    @staticmethod
    def empty() -> "Detections":
        return Detections(np.zeros((0, 4)), np.zeros(0), np.zeros(0))
