import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { readDeviceEnv } from '@/lib/env-parser';

const PYTHON_COUNTING_DIR = process.env.PYTHON_COUNTING_DIR || path.join(process.cwd(), '..', 'python-counting');
const STALE_MS = 5000;

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const env = readDeviceEnv(code);
  const deviceCode = env?.DEVICE_CODE || code;

  const bboxPath = path.join(PYTHON_COUNTING_DIR, `bbox_${deviceCode}.json`);

  if (!fs.existsSync(bboxPath)) {
    return NextResponse.json({ boxes: [], stale: true });
  }

  try {
    const raw = fs.readFileSync(bboxPath, 'utf-8');
    const data = JSON.parse(raw);
    const stale = (Date.now() / 1000 - (data.ts ?? 0)) > STALE_MS / 1000;
    return NextResponse.json({
      boxes: stale ? [] : (data.boxes ?? []),
      resolution: data.resolution ?? [800, 600],
      stale,
    });
  } catch {
    return NextResponse.json({ boxes: [], stale: true });
  }
}
