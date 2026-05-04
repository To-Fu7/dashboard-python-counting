import { NextResponse } from 'next/server';
import { readDeviceEnv } from '@/lib/env-parser';
import { captureFrame } from '@/lib/capture';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;

  const env = readDeviceEnv(code);
  if (!env?.RTSP_URL) {
    return NextResponse.json({ error: 'RTSP_URL not configured for this device' }, { status: 400 });
  }

  try {
    const frameBuffer = await captureFrame(env.RTSP_URL);
    const base64 = frameBuffer.toString('base64');
    return NextResponse.json({ image: `data:image/jpeg;base64,${base64}` });
  } catch (e) {
    return NextResponse.json({ error: `Frame capture failed: ${String(e)}` }, { status: 500 });
  }
}
