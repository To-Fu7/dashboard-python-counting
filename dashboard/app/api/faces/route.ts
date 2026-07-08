import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { generateFaceVariants } from '@/lib/face-augment';
import { insertKnownFace, listKnownFaces } from '@/lib/face-db';
import { readSettings } from '@/lib/settings';
import { embedFace, getModelMetadata } from '@/lib/triton';

const PHOTO_DIR = process.env.FACE_PHOTO_DIR || path.join(process.cwd(), 'data', 'face-photos');

function ensurePhotoDir(): void {
  if (!fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR, { recursive: true });
}

/** Resize + normalize a JPEG buffer into the CHW float32 tensor ArcFace expects. */
async function toEmbedTensor(jpegBuffer: Buffer, h: number, w: number): Promise<Float32Array> {
  const sharp = (await import('sharp')).default;
  const { data } = await sharp(jpegBuffer)
    .resize(w, h, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const tensor = new Float32Array(3 * h * w);
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const srcIdx = (y * w + x) * 3 + c;
        const dstIdx = c * h * w + y * w + x;
        tensor[dstIdx] = (data[srcIdx] - 127.5) / 128.0;
      }
    }
  }
  return tensor;
}

export async function GET() {
  try {
    const rows = await listKnownFaces();
    const byPerson = new Map<string, { person_name: string; variants: number; created_at: string }>();
    for (const row of rows) {
      const existing = byPerson.get(row.person_name);
      if (existing) {
        existing.variants += 1;
      } else {
        byPerson.set(row.person_name, { person_name: row.person_name, variants: 1, created_at: row.created_at });
      }
    }
    return NextResponse.json({ people: Array.from(byPerson.values()) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const settings = readSettings();
    const embedModel = settings.triton.faceEmbedModel;
    if (!embedModel) {
      return NextResponse.json(
        { error: 'No Face Embedding Model configured — set one on the Settings page first.' },
        { status: 400 },
      );
    }

    const formData = await req.formData();
    const name = (formData.get('name') as string | null)?.trim();
    const photo = formData.get('photo') as File | null;
    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });
    if (!photo) return NextResponse.json({ error: 'photo is required' }, { status: 400 });

    const meta = await getModelMetadata(embedModel);
    const inputDims = (meta.inputs[0]?.shape ?? []).map(Number);
    const [h, w] = inputDims.length >= 2 ? inputDims.slice(-2) : [112, 112];

    const inputBuffer = Buffer.from(await photo.arrayBuffer());
    const variants = await generateFaceVariants(inputBuffer);

    ensurePhotoDir();
    const sourcePhotoPath = path.join(PHOTO_DIR, `${uuidv4()}.jpg`);
    fs.writeFileSync(sourcePhotoPath, variants[0].buffer);

    const insertedIds: string[] = [];
    for (const variant of variants) {
      const tensor = await toEmbedTensor(variant.buffer, h > 0 ? h : 112, w > 0 ? w : 112);
      const embedding = await embedFace(embedModel, tensor, [1, 3, h > 0 ? h : 112, w > 0 ? w : 112]);
      const id = await insertKnownFace(name, embedding, variant.variantType, sourcePhotoPath);
      insertedIds.push(id);
    }

    return NextResponse.json({ success: true, personName: name, variantsInserted: insertedIds.length }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
