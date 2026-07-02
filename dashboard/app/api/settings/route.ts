import { NextResponse } from 'next/server';
import { readSettings, writeSettings } from '@/lib/settings';
import { applyHardwareModeToAll } from '@/lib/compose';

export async function GET() {
  try {
    const settings = readSettings();
    return NextResponse.json({ settings });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const prev = readSettings();
    const body = await request.json();
    writeSettings(body);
    const modeChanged = body.hardwareMode && body.hardwareMode !== prev.hardwareMode;
    const tritonTagChanged = body.triton?.imageTag && body.triton.imageTag !== prev.triton.imageTag;
    if (modeChanged || tritonTagChanged) {
      // regenerates every camera service AND the triton/model-builder services
      applyHardwareModeToAll(body.hardwareMode ?? prev.hardwareMode, body.triton?.imageTag);
    }
    return NextResponse.json({
      success: true,
      // jetson/server engines are TRT-version-specific — prompt a rebuild in the UI
      engineRebuildRecommended: Boolean(modeChanged || tritonTagChanged),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
