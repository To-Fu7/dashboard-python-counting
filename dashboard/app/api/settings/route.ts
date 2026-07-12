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

    // Merge, don't replace — a caller sending a partial body (e.g. just
    // { streamGateway: { publicBaseUrl } }) must not blow away every other
    // section (pg/mqtt credentials, hardwareMode, ...). Nested nully nested
    // objects merge shallowly per-section, matching how each section is a
    // flat bag of fields with no further nesting.
    const merged = {
      ...prev,
      ...body,
      triton: { ...prev.triton, ...body.triton },
      streamGateway: { ...prev.streamGateway, ...body.streamGateway },
      pg: { ...prev.pg, ...body.pg },
      mqtt: { ...prev.mqtt, ...body.mqtt },
      defaults: { ...prev.defaults, ...body.defaults },
    };
    writeSettings(merged);

    const modeChanged = body.hardwareMode && body.hardwareMode !== prev.hardwareMode;
    const tritonTagChanged = body.triton?.imageTag && body.triton.imageTag !== prev.triton.imageTag;
    const streamGatewayUrlChanged = body.streamGateway?.publicBaseUrl !== undefined
      && body.streamGateway.publicBaseUrl !== prev.streamGateway.publicBaseUrl;
    if (modeChanged || tritonTagChanged || streamGatewayUrlChanged) {
      // regenerates every camera service AND the triton/model-builder/stream-gateway services
      applyHardwareModeToAll(
        body.hardwareMode ?? prev.hardwareMode,
        body.triton?.imageTag,
        body.streamGateway?.publicBaseUrl ?? prev.streamGateway.publicBaseUrl
      );
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
