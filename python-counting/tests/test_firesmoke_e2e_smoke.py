"""End-to-end smoke test for the Fire/Smoke detection pipeline: runs the real
main.py loop on a local video file (FALLBACK_VIDEO — point this at any .mp4,
1.mp4 by default) with a local YOLO stand-in for both the primary and
fire/smoke Triton clients (same technique as test_e2e_smoke.py).

There's no real fire/smoke-trained model checked into this repo, so this
doesn't validate detection *accuracy* — it validates the *pipeline wiring*:
video decode from file -> fire/smoke inference sampling -> cooldown gate ->
increment_hourly + MQTT publish actually firing end-to-end. It does this by
relabeling the stand-in model's class 0 (person, since it reuses yolo11n.pt)
as "fire" via a monkeypatched load_model_classes — 1.mp4 has walking people,
so "fire" events are expected to fire during the run.

To point this at a different video: set FALLBACK_VIDEO before running, e.g.
    FALLBACK_VIDEO=smoke_test_clip.mp4 python tests/test_firesmoke_e2e_smoke.py

Run from python-counting/:  python tests/test_firesmoke_e2e_smoke.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ['SCREEN_RESOLUTION'] = '[800, 600]'
os.environ['lineA'] = '[(200, 300), (600, 300)]'
os.environ['DEBUG_MODE'] = 'true'
os.environ.setdefault('FALLBACK_VIDEO', '1.mp4')
os.environ['FRAME_SKIP'] = '1'
os.environ['POINT_AXIS'] = 'Y'
os.environ['FIRE_SMOKE_ENABLED'] = 'true'
os.environ['FIRE_SMOKE_MODEL'] = 'firesmoke_test_stub'  # no metadata.json needed; classes are monkeypatched
os.environ['FIRE_SMOKE_CONFIDENCE'] = '0.3'
os.environ['FIRE_SMOKE_COOLDOWN_MINUTES'] = '0'  # no cooldown suppression during the short test run

MAX_FRAMES = 150


class LocalYoloClient:
    """Drop-in for TritonYoloClient: same decode path, local torch inference.
    Reused as the stand-in for BOTH the primary and fire/smoke clients — main.py
    references the same TritonYoloClient symbol for every detector."""

    def __init__(self, *a, **kw):
        import torch
        from ultralytics import YOLO
        self._torch = torch
        self._model = YOLO('yolo11n.pt')
        self.calls = 0

    def infer(self, frame_bgr, pre_cache=None):
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


def _fake_classes(model_name):
    """Relabel class 0 (person, from the yolo11n stand-in) as 'fire' so the
    fire/smoke pipeline's label filter (firesmoke.py: `if label not in
    ('fire', 'smoke')`) actually lets events through during this test."""
    return {0: 'fire'}


if __name__ == '__main__':
    import main
    import app_state as state
    from detection import firesmoke

    main.TritonYoloClient = LocalYoloClient
    main.load_model_classes = _fake_classes
    main._imshow_available = False  # keep the run headless

    fire_events = []
    firesmoke.increment_hourly = lambda *a, **k: fire_events.append(('hourly', a))
    firesmoke.send_detection_event_mqtt = lambda *a, **k: fire_events.append(('mqtt', a))

    try:
        main.main()
    except SystemExit:
        pass

    print(f"\nProcessed {MAX_FRAMES} frames crash-free.")
    print(f"Fire/Smoke events fired: {len(fire_events)}")
    if len(fire_events) == 0:
        print("FAIL: no fire/smoke events fired — pipeline wiring broken "
              "(expected 'fire' events since 1.mp4 has people, relabeled class 0)")
        sys.exit(1)
    print("PASS")
