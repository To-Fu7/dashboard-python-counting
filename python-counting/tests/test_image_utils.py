"""Unit tests for outputs.image_utils.crop_image.

Run from python-counting/:  python tests/test_image_utils.py
"""
from testutil import check, finish  # bootstraps sys.path + base env vars

import numpy as np

import counting_config as cfg
from outputs.image_utils import crop_image


def _fake_frame(h=600, w=800):
    return np.zeros((h, w, 3), dtype=np.uint8)


def test_upscale_small_box():
    print("[1] small box gets upscaled to MIN_CROP_SIZE")
    frame = _fake_frame()
    # Box is small in both dimensions; even with padding it stays under MIN_CROP_SIZE.
    box = (400, 300, 420, 315)  # 20x15 before padding
    out = crop_image(frame, box, padding=2)
    out_h, out_w = out.shape[:2]
    check("output width >= MIN_CROP_SIZE[0]", out_w >= cfg.MIN_CROP_SIZE[0], f"got {out_w}")
    check("output height >= MIN_CROP_SIZE[1]", out_h >= cfg.MIN_CROP_SIZE[1], f"got {out_h}")

    crop_w, crop_h = (420 - 400 + 4), (315 - 300 + 4)  # padded box size before resize
    expected_ratio = crop_w / crop_h
    actual_ratio = out_w / out_h
    check("aspect ratio preserved within tolerance",
          abs(actual_ratio - expected_ratio) < 0.05,
          f"expected~={expected_ratio:.3f} actual={actual_ratio:.3f}")


def test_no_upscale_large_box():
    print("[2] box already >= MIN_CROP_SIZE is not resized")
    frame = _fake_frame()
    padding = cfg.CROP_PADDING
    x1, y1, x2, y2 = 100, 100, 300, 350  # 200x250, well over MIN_CROP_SIZE
    out = crop_image(frame, (x1, y1, x2, y2), padding=padding)
    expected_w = (x2 + padding) - (x1 - padding)
    expected_h = (y2 + padding) - (y1 - padding)
    out_h, out_w = out.shape[:2]
    check("width unchanged (no resize)", out_w == expected_w, f"expected {expected_w} got {out_w}")
    check("height unchanged (no resize)", out_h == expected_h, f"expected {expected_h} got {out_h}")


def test_clamp_at_frame_edge():
    print("[3] box near frame edge is clamped to frame bounds")
    h, w = 600, 800
    frame = _fake_frame(h, w)
    # Box touching top-left corner and one touching bottom-right corner.
    out_tl = crop_image(frame, (0, 0, 10, 10), padding=30)
    out_br = crop_image(frame, (w - 10, h - 10, w, h), padding=30)
    check("top-left crop height <= frame height", out_tl.shape[0] <= h)
    check("top-left crop width <= frame width", out_tl.shape[1] <= w)
    check("bottom-right crop height <= frame height", out_br.shape[0] <= h)
    check("bottom-right crop width <= frame width", out_br.shape[1] <= w)


def test_degenerate_box_does_not_crash():
    print("[4] degenerate/empty box (x2 <= x1) does not raise")
    frame = _fake_frame()
    try:
        out = crop_image(frame, (100, 100, 50, 200), padding=0)  # x2 < x1 -> empty width
        crashed = False
    except Exception as e:  # noqa: BLE001 - we want to catch ZeroDivisionError specifically too
        crashed = True
        out = None
        print(f"    exception: {e!r}")
    check("does not raise on degenerate box", not crashed)
    check("returns an array", out is not None and hasattr(out, "shape"))


def test_crop_face_zoom():
    print("[5] crop_face: margin expansion + tiny-face upscale")
    from outputs.image_utils import crop_face
    frame = _fake_frame()

    # Tiny distant CCTV face: 30x30 → margin makes 45x45 → upscaled to >= 112 shortest side
    out = crop_face(frame, (400, 300, 430, 330), margin=0.25, min_size=112)
    check("tiny face upscaled to min_size on shortest side", min(out.shape[:2]) >= 112,
          f"shape={out.shape}")

    # Large face: 200x200 → margin 25% each side = 300x300, NOT resized
    out = crop_face(frame, (100, 100, 300, 300), margin=0.25, min_size=112)
    check("large face gets margin but no resize", out.shape[:2] == (300, 300), f"shape={out.shape}")

    # Margin clamped at frame edges
    out = crop_face(frame, (0, 0, 200, 200), margin=0.25, min_size=112)
    check("margin clamps at frame edge (no negative index)", out.shape[:2] == (250, 250),
          f"shape={out.shape}")

    # Degenerate box returns empty without raising
    out = crop_face(frame, (100, 100, 100, 100))
    check("degenerate box returns empty array without raising", out.size == 0)


if __name__ == '__main__':
    test_upscale_small_box()
    test_no_upscale_large_box()
    test_clamp_at_frame_edge()
    test_degenerate_box_does_not_crash()
    test_crop_face_zoom()
    finish()
