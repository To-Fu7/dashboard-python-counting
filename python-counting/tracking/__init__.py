"""Torch-free ByteTrack, vendored from Ultralytics 8.3.239 (AGPL-3.0).

This is the exact tracker the legacy main.py used via model.track(tracker=
"bytetrack.yaml"), with torch/ultralytics imports removed so camera containers
stay slim. Deps: numpy, scipy, lap (lapx).
"""
from .byte_tracker import BYTETracker, STrack
from .config import BYTETrackerArgs, Detections

__all__ = ["BYTETracker", "STrack", "BYTETrackerArgs", "Detections"]
