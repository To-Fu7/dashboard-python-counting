import { NextResponse } from 'next/server';
import { readDeviceEnv } from '@/lib/env-parser';
import { getCameraStreamUrls } from '@/lib/stream-gateway';

export const dynamic = 'force-dynamic';

// Backs the device Stream tab's "Expose CCTV URL" button (Phase 4) — thin
// proxy to stream-gateway's own GET /api/v1/cameras/{code}/urls, plus the
// substream's URLs (registered as "<code>_sub") when SUBSTREAM_URL is set.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const env = readDeviceEnv(code);
  if (!env) {
    return NextResponse.json({ error: 'Device not found' }, { status: 404 });
  }

  try {
    const main = await getCameraStreamUrls(code);
    let sub = null;
    if (env.SUBSTREAM_URL) {
      try {
        sub = await getCameraStreamUrls(`${code}_sub`);
      } catch {
        sub = null; // substream not registered with stream-gateway yet
      }
    }
    return NextResponse.json({ main, sub });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
