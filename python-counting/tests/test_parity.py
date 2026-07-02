"""Parity tests: new tritonclient pipeline vs the legacy ultralytics pipeline.

Run from python-counting/:  python tests/test_parity.py

Requires ultralytics+torch locally (dev machine only — NOT in the slim image);
used to prove the numpy reimplementation is bit-compatible before rollout.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Minimal env so counting_config imports without a real .env
os.environ.setdefault('SCREEN_RESOLUTION', '[800, 600]')
os.environ.setdefault('lineA', '[(351, 51), (381, 207)]')
os.environ.setdefault('DEBUG_MODE', 'true')

import cv2
import numpy as np

PASS = FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name} {detail}")


def get_test_frame():
    cap = cv2.VideoCapture('1.mp4')
    for _ in range(30):
        ret, frame = cap.read()
    cap.release()
    assert ret, "could not read 1.mp4"
    frame = cv2.resize(frame, (800, 600))
    return frame


def test_letterbox_parity(frame):
    print("[1] letterbox vs ultralytics LetterBox")
    from ultralytics.data.augment import LetterBox
    from inference.preprocessing import letterbox

    for shape in [(640, 640), (416, 416)]:
        ours, r, (dw, dh) = letterbox(frame, shape)
        theirs = LetterBox(shape, auto=False, scaleup=True)(image=frame)
        check(f"letterbox {shape} image identical", np.array_equal(ours, theirs),
              f"maxdiff={np.abs(ours.astype(int) - theirs.astype(int)).max()}")
        exp_r = min(shape[0] / frame.shape[0], shape[1] / frame.shape[1])
        check(f"letterbox {shape} ratio", abs(r - exp_r) < 1e-9)


def test_nms_decode_parity(frame):
    print("[2] decode_raw + numpy NMS vs ultralytics non_max_suppression")
    import torch
    from ultralytics import YOLO
    from ultralytics.utils import nms as ops
    from inference.preprocessing import preprocess
    from inference.postprocessing import decode_raw

    model = YOLO('yolo11n.pt')
    tensor, ratio, pad = preprocess(frame, (640, 640))
    with torch.no_grad():
        raw = model.model(torch.from_numpy(tensor))  # raw head output
    raw_np = raw[0].numpy() if isinstance(raw, (list, tuple)) else raw.numpy()

    ours = decode_raw(raw_np[0], conf_thresh=0.3, iou_thresh=0.3, class_id=0)
    theirs = ops.non_max_suppression(
        raw[0] if isinstance(raw, (list, tuple)) else raw,
        conf_thres=0.3, iou_thres=0.3, classes=[0])[0].numpy()

    check("same detection count", len(ours) == len(theirs),
          f"ours={len(ours)} theirs={len(theirs)}")
    if len(ours) == len(theirs) and len(ours) > 0:
        o = ours[np.lexsort((ours[:, 0], ours[:, 1]))]
        t = theirs[np.lexsort((theirs[:, 0], theirs[:, 1]))]
        box_diff = np.abs(o[:, :4] - t[:, :4]).max()
        conf_diff = np.abs(o[:, 4] - t[:, 4]).max()
        check("boxes match (<0.5px)", box_diff < 0.5, f"maxdiff={box_diff:.4f}")
        check("confidences match (<1e-3)", conf_diff < 1e-3, f"maxdiff={conf_diff:.5f}")


def test_unletterbox_parity(frame):
    print("[3] unletterbox vs ultralytics scale_boxes")
    import torch
    from ultralytics.utils import ops
    from inference.preprocessing import preprocess
    from inference.postprocessing import unletterbox

    tensor, ratio, pad = preprocess(frame, (640, 640))
    boxes = np.array([[100.0, 50.0, 300.0, 400.0, 0.9, 0.0],
                      [5.0, 80.0, 60.0, 630.0, 0.5, 0.0]], dtype=np.float32)
    ours = unletterbox(boxes.copy(), ratio, pad, frame.shape[:2])
    theirs = ops.scale_boxes((640, 640), torch.from_numpy(boxes[:, :4].copy()), frame.shape[:2]).numpy()
    diff = np.abs(ours[:, :4] - theirs).max()
    check("coordinates match (<0.5px)", diff < 0.5, f"maxdiff={diff:.4f}")


def test_tracker_parity(frame):
    print("[4] vendored ByteTrack vs ultralytics ByteTrack (full video, real detections)")
    import torch
    from types import SimpleNamespace
    from ultralytics import YOLO
    from ultralytics.trackers.byte_tracker import BYTETracker as UltraBYTE
    from tracking import BYTETracker, BYTETrackerArgs, Detections
    from inference.preprocessing import preprocess
    from inference.postprocessing import decode_raw, unletterbox

    args_dict = dict(track_high_thresh=0.25, track_low_thresh=0.1, new_track_thresh=0.25,
                     track_buffer=30, match_thresh=0.8, fuse_score=True)
    ours_trk = BYTETracker(BYTETrackerArgs(), frame_rate=30)
    theirs_trk = UltraBYTE(SimpleNamespace(**args_dict), frame_rate=30)

    model = YOLO('yolo11n.pt')
    cap = cv2.VideoCapture('1.mp4')
    mismatches = 0
    frames_checked = 0
    for i in range(60):  # 60 frames is enough to exercise birth/match/lost logic
        ret, f = cap.read()
        if not ret:
            break
        f = cv2.resize(f, (800, 600))
        tensor, ratio, pad = preprocess(f, (640, 640))
        with torch.no_grad():
            raw = model.model(torch.from_numpy(tensor))
        raw_np = (raw[0] if isinstance(raw, (list, tuple)) else raw).numpy()
        dets = decode_raw(raw_np[0], 0.3, 0.3, 0)
        dets = unletterbox(dets, ratio, pad, f.shape[:2])

        d = Detections(dets[:, :4], dets[:, 4], dets[:, 5])
        r_ours = ours_trk.update(d)
        r_theirs = theirs_trk.update(d)  # same container works: needs .conf/.xywh/.cls/getitem
        frames_checked += 1
        ids_ours = sorted(r_ours[:, 4].astype(int).tolist()) if len(r_ours) else []
        ids_theirs = sorted(r_theirs[:, 4].astype(int).tolist()) if len(r_theirs) else []
        if ids_ours != ids_theirs:
            mismatches += 1
    cap.release()
    check(f"track IDs identical across {frames_checked} frames", mismatches == 0,
          f"mismatched frames={mismatches}")


def test_module_imports():
    print("[5] module import smoke (no torch/ultralytics in the runtime import graph)")
    import counting_config  # noqa
    import app_state  # noqa
    import counting  # noqa
    import lifecycle  # noqa
    from outputs import db_worker, mqtt_out, mjpeg_server, bbox_writer  # noqa
    from inference import TritonYoloClient  # noqa
    banned = [m for m in sys.modules if m.split('.')[0] in ('torch', 'ultralytics', 'tensorrt')]
    # torch/ultralytics may already be loaded by earlier tests — check statically instead
    import subprocess
    code = (
        "import os,sys;"
        "os.environ.setdefault('SCREEN_RESOLUTION','[800,600]');"
        "os.environ.setdefault('lineA','[(0,0),(10,10)]');"
        "os.environ.setdefault('DEBUG_MODE','true');"
        "import counting_config, app_state, counting, lifecycle;"
        "from outputs import db_worker, mqtt_out, mjpeg_server, bbox_writer;"
        "from inference import TritonYoloClient;"
        "from tracking import BYTETracker;"
        "bad=[m.split('.')[0] for m in sys.modules if m.split('.')[0] in ('torch','ultralytics','tensorrt')];"
        "print('BANNED:'+','.join(sorted(set(bad))) if bad else 'CLEAN')"
    )
    out = subprocess.run([sys.executable, '-c', code],
                         capture_output=True, text=True,
                         cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    check("runtime import graph is torch/ultralytics-free",
          'CLEAN' in out.stdout, out.stdout.strip() + out.stderr.strip()[-300:])


if __name__ == '__main__':
    frame = get_test_frame()
    test_letterbox_parity(frame)
    test_nms_decode_parity(frame)
    test_unletterbox_parity(frame)
    test_tracker_parity(frame)
    test_module_imports()
    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)
