import { NextRequest } from 'next/server';
import { spawn } from 'child_process';
import { readDeviceEnv } from '@/lib/env-parser';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;

  const env = readDeviceEnv(code);
  if (!env?.RTSP_URL) {
    return new Response('RTSP_URL not configured', { status: 400 });
  }

  let ffmpeg: ReturnType<typeof spawn> | null = null;

  const rtspUrl = env.RTSP_URL;
  const isLocalDevice = /^(\d+|\/dev\/)/.test(rtspUrl);
  const encoder = new TextEncoder();

  const fpsLimit = parseFloat(env.FPS_LIMIT ?? '0');
  const streamFps = fpsLimit > 0 ? String(Math.min(fpsLimit, 30)) : '10';

  const stream = new ReadableStream({
    start(controller) {
      const args = [
        '-loglevel', 'error',
        ...(!isLocalDevice ? ['-rtsp_transport', 'tcp'] : []),
        '-i', rtspUrl,
        '-f', 'mpjpeg',
        '-q:v', '5',
        '-r', streamFps,
        'pipe:1',
      ];
      ffmpeg = spawn('ffmpeg', args);

      if (!ffmpeg.stdout) { controller.close(); return; }

      let buf = Buffer.alloc(0);

      ffmpeg.stdout.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);

        // Parse complete MJPEG frames from the accumulated buffer.
        // ffmpeg mpjpeg format: --ffserver\r\nContent-Type:...\r\nContent-Length: N\r\n\r\n<N bytes JPEG>
        let safety = 20;
        while (safety-- > 0) {
          const hdrEnd = buf.indexOf('\r\n\r\n');
          if (hdrEnd === -1) break;

          const hdr = buf.subarray(0, hdrEnd).toString();
          const m = hdr.match(/Content-Length:\s*(\d+)/i);
          if (!m) {
            // Malformed header — skip to next boundary marker
            const next = buf.indexOf('--', 2);
            buf = next >= 0 ? buf.subarray(next) : Buffer.alloc(0);
            continue;
          }

          const jpegLen = parseInt(m[1]);
          const dataStart = hdrEnd + 4;
          if (buf.length < dataStart + jpegLen) break; // incomplete frame, wait

          const jpeg = buf.subarray(dataStart, dataStart + jpegLen);
          buf = buf.subarray(dataStart + jpegLen);

          try {
            controller.enqueue(encoder.encode(`data: ${jpeg.toString('base64')}\n\n`));
          } catch {
            ffmpeg?.kill('SIGKILL');
            return;
          }
        }
      });

      ffmpeg.on('close', () => { try { controller.close(); } catch { /* already closed */ } });
      ffmpeg.on('error', () => { try { controller.close(); } catch { /* already closed */ } });
    },
    cancel() { ffmpeg?.kill('SIGKILL'); },
  });

  request.signal.addEventListener('abort', () => { ffmpeg?.kill('SIGKILL'); });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
