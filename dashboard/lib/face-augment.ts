// Server-side face-photo augmentation for enrollment: generates a handful of
// variants (skew, contrast, flip) from one uploaded photo so matching at
// runtime is more robust to lighting/angle than a single embedding would be.
// Mirrors the Python-side design: each variant gets its own known_faces row,
// matching takes the best similarity across all rows for a person, not an average.
import sharp from 'sharp';

export interface FaceVariant {
  variantType: 'original' | 'skew' | 'contrast' | 'flip';
  buffer: Buffer;
}

export async function generateFaceVariants(input: Buffer): Promise<FaceVariant[]> {
  const base = sharp(input).rotate(); // auto-orient from EXIF before deriving variants

  const [original, flip, contrastUp, contrastDown, skew] = await Promise.all([
    base.clone().jpeg().toBuffer(),
    base.clone().flop().jpeg().toBuffer(),
    base.clone().linear(1.3, -20).jpeg().toBuffer(),
    base.clone().linear(0.7, 20).jpeg().toBuffer(),
    base.clone().affine([1, 0.15, 0, 1], { background: '#000000' }).jpeg().toBuffer(),
  ]);

  return [
    { variantType: 'original', buffer: original },
    { variantType: 'flip', buffer: flip },
    { variantType: 'contrast', buffer: contrastUp },
    { variantType: 'contrast', buffer: contrastDown },
    { variantType: 'skew', buffer: skew },
  ];
}
