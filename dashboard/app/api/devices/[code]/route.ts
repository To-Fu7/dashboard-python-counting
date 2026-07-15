import { NextResponse } from 'next/server';
import { readDeviceEnv, writeDeviceEnv, deleteDeviceEnv } from '@/lib/env-parser';
import { removeService, serviceExists, getContainerName, composeStop } from '@/lib/compose';
import { getContainerStatus } from '@/lib/docker';
import { upsertCameraStream, removeCameraStream } from '@/lib/stream-gateway';
import { deployPortForwardConfig } from '@/lib/portforward';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const env = readDeviceEnv(code);
  if (!env) {
    return NextResponse.json({ error: 'Device not found' }, { status: 404 });
  }
  const containerName = getContainerName(code);
  const status = await getContainerStatus(containerName);
  return NextResponse.json({ env, status, containerName });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  try {
    const body = await request.json();
    const existing = readDeviceEnv(code);
    if (!existing) {
      return NextResponse.json({ error: 'Device not found' }, { status: 404 });
    }

    // Merge, don't replace — a partial body (any field left out) must not
    // wipe the rest back to writeDeviceEnv's hardcoded defaults. The real
    // device edit page always sends the full env object it loaded via GET,
    // so this was never reachable through normal use, but it's the correct
    // way to implement PUT regardless (same class of bug just fixed in
    // /api/settings).
    const merged = { ...existing, ...body };
    writeDeviceEnv(code, merged);

    // Best-effort: re-push this device's stream config to stream-gateway on
    // every save, same "regenerate from current state" posture as the
    // compose-service regeneration elsewhere in this file. Not blocking —
    // stream-gateway being down shouldn't fail a settings save.
    if (merged.RTSP_URL) {
      upsertCameraStream(code, {
        rtspUrl: merged.RTSP_URL,
        onDemand: merged.STREAM_GATEWAY_ALWAYS_ON !== 'true',
        includeAudio: merged.STREAM_GATEWAY_AUDIO === 'true',
      }).catch(err => console.warn(`stream-gateway update failed for ${code}:`, err));
    }
    const subCode = `${code}_sub`;
    if (merged.SUBSTREAM_URL) {
      upsertCameraStream(subCode, {
        rtspUrl: merged.SUBSTREAM_URL,
        onDemand: merged.STREAM_GATEWAY_ALWAYS_ON !== 'true',
        includeAudio: merged.STREAM_GATEWAY_AUDIO === 'true',
      }).catch(err => console.warn(`stream-gateway update failed for ${subCode}:`, err));
    } else {
      // Substream URL was cleared — deregister it if it existed.
      removeCameraStream(subCode).catch(() => {});
    }

    // Regenerate + redeploy the port-forward nginx on every save regardless of
    // whether PORTFWD_* fields were in this particular partial body, since
    // disabling a forward (PORTFWD_ENABLED=false) also needs a redeploy to drop
    // it. Unlike the fire-and-forget stream-gateway calls above, this is AWAITED
    // so the response can tell the UI whether nginx actually got the new config
    // — a silent fire-and-forget here was why saves looked applied but weren't.
    // The env is already persisted; a deploy failure is reported, not fatal.
    let portForward;
    try {
      portForward = await deployPortForwardConfig();
    } catch (err) {
      portForward = { deployed: false, error: String(err) };
    }

    return NextResponse.json({ success: true, portForward });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  try {
    try {
      await composeStop(code);
    } catch {
      // Ignore stop errors (container may not exist)
    }

    if (serviceExists(code)) {
      removeService(code);
    }

    deleteDeviceEnv(code);

    // Best-effort, same non-blocking posture as PUT above.
    removeCameraStream(code).catch(() => {});
    removeCameraStream(`${code}_sub`).catch(() => {});
    deployPortForwardConfig().catch(() => {}); // deleteDeviceEnv already dropped its forward from collectPortForwards()

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
