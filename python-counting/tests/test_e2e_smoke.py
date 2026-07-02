"""End-to-end smoke: run the real main.py loop on 1.mp4 with a local YOLO stand-in
for Triton (preprocess/decode/tracker already parity-proven in test_parity.py).
Proves the orchestrator + counting + state wiring runs crash-free.

Run from python-counting/:  python tests/test_e2e_smoke.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ['SCREEN_RESOLUTION'] = '[800, 600]'
os.environ['lineA'] = '[(200, 300), (600, 300)]'
os.environ['DEBUG_MODE'] = 'true'
os.environ['FALLBACK_VIDEO'] = '1.mp4'
os.environ['FRAME_SKIP'] = '1'
os.environ['POINT_AXIS'] = 'Y'

MAX_FRAMES = 150


class LocalYoloClient:
    """Drop-in for TritonYoloClient: same decode path, local torch inference."""

    def __init__(self, *a, **kw):
        import torch
        from ultralytics import YOLO
        self._torch = torch
        self._model = YOLO('yolo11n.pt')
        self.calls = 0

    def infer(self, frame_bgr):
        from inference.preprocessing import preprocess
        from inference.postprocessing import decode_raw, unletterbox
        self.calls += 1
        if self.calls > MAX_FRAMES:
            raise SystemExit(0)  # BaseException — escapes main's retry loop
        tensor, ratio, pad = preprocess(frame_bgr, (640, 640))
        with self._torch.no_grad():
            raw = self._model.model(self._torch.from_numpy(tensor))
        raw_np = (raw[0] if isinstance(raw, (list, tuple)) else raw).numpy()
        dets = decode_raw(raw_np[0], 0.3, 0.3, 0)
        return unletterbox(dets, ratio, pad, frame_bgr.shape[:2])


if __name__ == '__main__':
    import main
    import app_state as state

    main.TritonYoloClient = LocalYoloClient
    main._imshow_available = False  # keep the run headless

    try:
        main.main()
    except SystemExit:
        pass

    total_tracked = len(state.last_points)
    print(f"\nProcessed {MAX_FRAMES} frames crash-free.")
    print(f"Tracked persons (unique ids with points): {total_tracked}")
    print(f"IN={state.person_in} OUT={state.person_out}")
    if total_tracked == 0:
        print("FAIL: no persons tracked — pipeline broken")
        sys.exit(1)
    print("PASS")
