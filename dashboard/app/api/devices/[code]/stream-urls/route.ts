import { NextResponse } from 'next/server';
import { readDeviceEnv } from '@/lib/env-parser';
import { getCameraStreamUrls, upsertCameraStream } from '@/lib/stream-gateway';
import { readSettings } from '@/lib/settings';

export const dynamic = 'force-dynamic';

// Backs the device Stream tab's "Expose CCTV URL" button (Phase 4) and the
// Stream grid page (Phase 6) — proxy to stream-gateway's own
// GET /api/v1/cameras/{code}/urls, plus the substream's URLs (registered as
// "<code>_sub") when SUBSTREAM_URL is set.
//
// stream-gateway keeps camera registrations in memory only (no persistence
// layer) — if its container restarts, every camera is unregistered again
// until whichever device page happens to get saved next re-upserts it. The
// grid page needs EVERY camera registered on every load, not just recently
// edited ones, so this route self-heals: upsert first (idempotent, cheap —
// stream-gateway only reconnects if the config actually changed), then look
// up URLs, instead of assuming a prior PUT already registered it.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const env = readDeviceEnv(code);
  if (!env) {
    return NextResponse.json({ error: 'Device not found' }, { status: 404 });
  }
  if (!env.RTSP_URL) {
    return NextResponse.json({ error: 'RTSP_URL not configured' }, { status: 400 });
  }

  try {
    await upsertCameraStream(code, {
      rtspUrl: env.RTSP_URL,
      onDemand: env.STREAM_GATEWAY_ALWAYS_ON !== 'true',
      includeAudio: env.STREAM_GATEWAY_AUDIO === 'true',
    });
    const main = await getCameraStreamUrls(code);

    let sub = null;
    if (env.SUBSTREAM_URL) {
      try {
        await upsertCameraStream(`${code}_sub`, {
          rtspUrl: env.SUBSTREAM_URL,
          onDemand: env.STREAM_GATEWAY_ALWAYS_ON !== 'true',
          includeAudio: env.STREAM_GATEWAY_AUDIO === 'true',
        });
        sub = await getCameraStreamUrls(`${code}_sub`);
      } catch {
        sub = null;
      }
    }
    // The URLs above are built against the gateway's own PUBLIC_BASE_URL, which
    // can't know how the browser reached us. Hand the configured override along
    // (usually empty) so the client can repoint them — see toReachableStreamUrl.
    return NextResponse.json({
      main,
      sub,
      publicBaseUrl: readSettings().streamGateway.publicBaseUrl,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
