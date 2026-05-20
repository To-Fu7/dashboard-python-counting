import { NextRequest } from 'next/server';
import { spawn } from 'child_process';
import { request as httpRequest } from 'node:http';
import { readDeviceEnv } from '@/lib/env-parser';
import { getDocker } from '@/lib/docker';
import { getContainerName } from '@/lib/compose';

async function isContainerRunning(containerName: string): Promise<boolean> {
  try {
    const docker = getDocker();
    const container = docker.getContainer(containerName);
    const info = await container.inspect();
    return info.State?.Running === true;
  } catch {
    return false;
  }
}

function proxyAnnotatedStream(host: string, port: number): Promise<ReadableStream | null> {
  return new Promise((resolve) => {
    const req = httpRequest({ host, port, path: '/', method: 'GET' }, (res) => {
      if (res.statusCode !== 200) { res.destroy(); resolve(null); return; }

      // Clear socket timeout — we have a live 200, data will arrive once Python encodes a frame
      req.setTimeout(0);

      const stream = new ReadableStream({
        start(controller) {
          res.on('data', (chunk: Buffer) => {
            try { controller.enqueue(chunk); } catch { res.destroy(); }
          });
          res.on('end', () => { try { controller.close(); } catch {} });
          res.on('error', () => { try { controller.close(); } catch {} });
        },
        cancel() { res.destroy(); },
      });
      resolve(stream);
    });

    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;

  const env = readDeviceEnv(code);
  if (!env?.RTSP_URL) {
    return new Response('RTSP_URL not configured', { status: 400 });
  }

  const containerName = getContainerName(code);
  const streamPort = parseInt(env.STREAM_PORT || '8090', 10);

  // Try annotated stream from Python container first (zero frame mismatch)
  if (streamPort > 0 && await isContainerRunning(containerName)) {
    const annotatedStream = await proxyAnnotatedStream(containerName, streamPort);
    if (annotatedStream) {
      return new Response(annotatedStream, {
        headers: {
          'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
          'Cache-Control': 'no-cache, no-store',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      });
    }
  }

  // Fallback: raw RTSP via ffmpeg (no bounding boxes)
  const rtspUrl = env.RTSP_URL;
  const isLocalDevice = /^(\d+|\/dev\/)/.test(rtspUrl);

  const url = new URL(request.url);
  const reqFps = parseFloat(url.searchParams.get('fps') || '0');
  const reqQ = parseInt(url.searchParams.get('q') || '0', 10);

  const fpsLimit = parseFloat(env.FPS_LIMIT ?? '0');
  const streamFps = reqFps > 0 ? String(Math.min(reqFps, 30))
    : fpsLimit > 0 ? String(Math.min(fpsLimit, 30))
    : '10';
  const quality = reqQ > 0 ? String(Math.min(reqQ, 31)) : '5';

  let ffmpeg: ReturnType<typeof spawn> | null = null;
  let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      maxDurationTimer = setTimeout(() => {
        ffmpeg?.kill('SIGKILL');
        try { controller.close(); } catch {}
      }, 15 * 60 * 1000);

      const args = [
        '-loglevel', 'error',
        ...(!isLocalDevice ? ['-rtsp_transport', 'tcp'] : []),
        '-i', rtspUrl,
        '-f', 'mpjpeg',
        '-q:v', quality,
        '-r', streamFps,
        'pipe:1',
      ];
      ffmpeg = spawn('ffmpeg', args);

      if (!ffmpeg.stdout) {
        if (maxDurationTimer) { clearTimeout(maxDurationTimer); maxDurationTimer = null; }
        try { controller.close(); } catch {}
        return;
      }

      ffmpeg.stdout.on('data', (chunk: Buffer) => {
        try { controller.enqueue(chunk); } catch { ffmpeg?.kill('SIGKILL'); }
      });
      ffmpeg.on('close', () => {
        if (maxDurationTimer) { clearTimeout(maxDurationTimer); maxDurationTimer = null; }
        try { controller.close(); } catch {}
      });
      ffmpeg.on('error', () => {
        if (maxDurationTimer) { clearTimeout(maxDurationTimer); maxDurationTimer = null; }
        try { controller.close(); } catch {}
      });
    },
    cancel() {
      if (maxDurationTimer) { clearTimeout(maxDurationTimer); maxDurationTimer = null; }
      ffmpeg?.kill('SIGKILL');
    },
  });

  request.signal.addEventListener('abort', () => { ffmpeg?.kill('SIGKILL'); });

  return new Response(stream, {
    headers: {
      'Content-Type': 'multipart/x-mixed-replace; boundary=ffmpeg',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
