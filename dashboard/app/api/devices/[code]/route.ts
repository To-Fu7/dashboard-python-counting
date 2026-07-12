import { NextResponse } from 'next/server';
import { readDeviceEnv, writeDeviceEnv, deleteDeviceEnv } from '@/lib/env-parser';
import { removeService, serviceExists, getContainerName, composeStop } from '@/lib/compose';
import { getContainerStatus } from '@/lib/docker';
import { upsertCameraStream, removeCameraStream } from '@/lib/stream-gateway';

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

    writeDeviceEnv(code, body);

    // Best-effort: re-push this device's stream config to stream-gateway on
    // every save, same "regenerate from current state" posture as the
    // compose-service regeneration elsewhere in this file. Not blocking —
    // stream-gateway being down shouldn't fail a settings save.
    const merged = { ...existing, ...body };
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

    return NextResponse.json({ success: true });
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

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
