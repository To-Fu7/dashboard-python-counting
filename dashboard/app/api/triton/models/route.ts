import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getHealth, getRepositoryIndex, loadModel, unloadModel } from '@/lib/triton';

const PYTHON_COUNTING_DIR = process.env.PYTHON_COUNTING_DIR || path.join(process.cwd(), '..', 'python-counting');
const MODELS_DIR = path.join(PYTHON_COUNTING_DIR, 'models');

export const dynamic = 'force-dynamic';

/** List models: union of the on-disk repository (always available, even when
 *  Triton is down) and Triton's live repository index (adds READY state). */
export async function GET() {
  try {
    const onDisk: { name: string; hasOnnx: boolean; hasPlan: boolean; metadata?: unknown }[] = [];
    if (fs.existsSync(MODELS_DIR)) {
      for (const entry of fs.readdirSync(MODELS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(MODELS_DIR, entry.name);
        if (!fs.existsSync(path.join(dir, 'config.pbtxt'))) continue;
        let metadata: unknown;
        try {
          metadata = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf-8'));
        } catch { /* optional */ }
        onDisk.push({
          name: entry.name,
          hasOnnx: fs.existsSync(path.join(dir, '1', 'model.onnx')),
          hasPlan: fs.existsSync(path.join(dir, '1', 'model.plan')),
          metadata,
        });
      }
    }

    const states: Record<string, string> = {};
    const health = await getHealth();
    if (health.ready) {
      try {
        for (const m of await getRepositoryIndex()) {
          states[m.name] = m.state || 'UNKNOWN';
        }
      } catch { /* index unavailable */ }
    }

    const models = onDisk.map(m => ({ ...m, state: states[m.name] ?? 'OFFLINE' }));
    return NextResponse.json({ models, tritonReady: health.ready });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/** POST { name, action: 'load' | 'unload' } */
export async function POST(request: Request) {
  try {
    const { name, action } = await request.json();
    if (!name || !['load', 'unload'].includes(action)) {
      return NextResponse.json({ error: 'name and action (load|unload) are required' }, { status: 400 });
    }
    if (action === 'load') await loadModel(name);
    else await unloadModel(name);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
