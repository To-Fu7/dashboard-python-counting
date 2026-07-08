// Server-side face-photo augmentation for enrollment: generates variants from
// one uploaded photo so matching at runtime is more robust to CCTV conditions
// (lighting day/night, low-res streams, compression, occlusion) than a single
// embedding would be. Mirrors the Python-side design: each variant gets its own
// known_faces row, matching takes the best similarity across all rows for a
// person, not an average.
//
// Variant families (per the enrollment design):
// - geometric:  flip, small rotations (±12° — larger distorts facial structure),
//               center crop, low-res round-trip (scale down→up)
// - photometric: brightness up/down, contrast up/down, desaturation, gamma
// - noise/blur: gaussian blur (motion/defocus stand-in), heavy JPEG artifacts
//               (RTSP/CCTV compression)
// - occlusion:  black patch over the lower face (mask-like) and over the eye
//               region (cap/sunglasses-like)
// Deliberately NOT done: 3DMM pose synthesis (out of scope, needs a 3D pipeline)
// and Mixup/CutMix (identity-destroying for face recognition).
import sharp, { type Sharp } from 'sharp';

export interface FaceVariant {
  variantType: string;
  buffer: Buffer;
}

/** Rotate by a small angle, then center-crop back to the original dimensions
 *  so the canvas growth from rotation doesn't shrink the face. */
async function rotateCentered(base: Sharp, angle: number, w: number, h: number): Promise<Buffer> {
  const rotated = await base.clone().rotate(angle, { background: '#000000' }).toBuffer();
  const meta = await sharp(rotated).metadata();
  const left = Math.max(0, Math.floor(((meta.width ?? w) - w) / 2));
  const top = Math.max(0, Math.floor(((meta.height ?? h) - h) / 2));
  return sharp(rotated).extract({ left, top, width: w, height: h }).jpeg().toBuffer();
}

/** Black rectangle composited over a region given in fractions of the image. */
async function occlude(base: Sharp, w: number, h: number,
                       fx: number, fy: number, fw: number, fh: number): Promise<Buffer> {
  const patch = await sharp({
    create: {
      width: Math.max(1, Math.round(w * fw)),
      height: Math.max(1, Math.round(h * fh)),
      channels: 3,
      background: '#000000',
    },
  }).jpeg().toBuffer();
  return base.clone()
    .composite([{ input: patch, left: Math.round(w * fx), top: Math.round(h * fy) }])
    .jpeg().toBuffer();
}

export async function generateFaceVariants(input: Buffer): Promise<FaceVariant[]> {
  const base = sharp(input).rotate(); // auto-orient from EXIF before deriving variants
  const meta = await base.metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) throw new Error('Could not read image dimensions');

  // center crop at 85% then back to original size (framing variation)
  const cw = Math.round(w * 0.85);
  const ch = Math.round(h * 0.85);

  const [
    original, flip,
    rotPlus, rotMinus,
    centerCrop, lowres,
    brightUp, brightDown, contrastUp, contrastDown, desaturated, gammaCorr,
    blur, jpegArtifact,
    maskLower, maskEyes,
  ] = await Promise.all([
    // --- geometric
    base.clone().jpeg().toBuffer(),
    base.clone().flop().jpeg().toBuffer(),
    rotateCentered(base, 12, w, h),
    rotateCentered(base, -12, w, h),
    base.clone()
      .extract({ left: Math.floor((w - cw) / 2), top: Math.floor((h - ch) / 2), width: cw, height: ch })
      .resize(w, h).jpeg().toBuffer(),
    base.clone().resize(Math.max(32, Math.round(w * 0.35))).resize(w).jpeg().toBuffer(),
    // --- photometric
    base.clone().modulate({ brightness: 1.35 }).jpeg().toBuffer(),
    base.clone().modulate({ brightness: 0.65 }).jpeg().toBuffer(),
    base.clone().linear(1.3, -20).jpeg().toBuffer(),
    base.clone().linear(0.7, 20).jpeg().toBuffer(),
    base.clone().modulate({ saturation: 0.35 }).jpeg().toBuffer(),
    base.clone().gamma(2.2).jpeg().toBuffer(),
    // --- noise / blur / compression
    base.clone().blur(2).jpeg().toBuffer(),
    base.clone().jpeg({ quality: 25 }).toBuffer(),
    // --- occlusion (fractions tuned for a roughly face-filling photo)
    occlude(base, w, h, 0.15, 0.55, 0.70, 0.35),  // lower face — mask-like
    occlude(base, w, h, 0.15, 0.25, 0.70, 0.18),  // eye band — cap/sunglasses-like
  ]);

  return [
    { variantType: 'original', buffer: original },
    { variantType: 'flip', buffer: flip },
    { variantType: 'rotate_+12', buffer: rotPlus },
    { variantType: 'rotate_-12', buffer: rotMinus },
    { variantType: 'crop', buffer: centerCrop },
    { variantType: 'lowres', buffer: lowres },
    { variantType: 'brightness_up', buffer: brightUp },
    { variantType: 'brightness_down', buffer: brightDown },
    { variantType: 'contrast_up', buffer: contrastUp },
    { variantType: 'contrast_down', buffer: contrastDown },
    { variantType: 'desaturated', buffer: desaturated },
    { variantType: 'gamma', buffer: gammaCorr },
    { variantType: 'blur', buffer: blur },
    { variantType: 'jpeg_artifact', buffer: jpegArtifact },
    { variantType: 'occlusion_lower', buffer: maskLower },
    { variantType: 'occlusion_eyes', buffer: maskEyes },
  ];
}
