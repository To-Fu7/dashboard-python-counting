import { request as httpRequest } from 'node:http';
import { readDeviceEnv } from '@/lib/env-parser';
import { getDocker } from '@/lib/docker';
import { getContainerName } from '@/lib/compose';

async function getContainerHost(containerName: string): Promise<string> {
  try {
    const docker = getDocker();
    const info = await docker.getContainer(containerName).inspect();
    const networks = info.NetworkSettings?.Networks ?? {};
    for (const net of Object.values(networks)) {
      const ip = (net as { IPAddress?: string }).IPAddress;
      if (ip) return ip;
    }
  } catch { /* fall through */ }
  // Fallback: use container name directly (works inside Docker network)
  return containerName;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const env = readDeviceEnv(code);
  const streamPort = parseInt(env?.STREAM_PORT || '8090', 10);

  if (!env || streamPort <= 0) {
    return new Response('Annotated stream not configured', { status: 404 });
  }

  const containerName = getContainerName(code);
  const host = await getContainerHost(containerName);
  console.log(`[annotated] host=${host} port=${streamPort}`);

  return new Promise<Response>((resolve) => {
    let settled = false;
    const settle = (r: Response) => { if (!settled) { settled = true; resolve(r); } };

    const req = httpRequest({ host, port: streamPort, path: '/', method: 'GET' }, (res) => {
      console.log(`[annotated] status=${res.statusCode}`);
      if (res.statusCode !== 200) {
        res.destroy();
        settle(new Response('Annotated stream unavailable', { status: 503 }));
        return;
      }

      res.pause();

      const firstByteTimer = setTimeout(() => {
        console.log(`[annotated] firstByteTimer fired — no data in 10s`);
        res.destroy();
        settle(new Response('No frames yet', { status: 503 }));
      }, 10000);

      res.once('data', (firstChunk: Buffer) => {
        clearTimeout(firstByteTimer);
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(firstChunk);
            res.on('data', (chunk: Buffer) => {
              try { controller.enqueue(chunk); } catch { res.destroy(); }
            });
            res.on('end', () => { try { controller.close(); } catch {} });
            res.on('error', () => { try { controller.close(); } catch {} });
            res.resume();
          },
          cancel() { res.destroy(); },
        });
        settle(new Response(stream, {
          headers: {
            'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
            'Cache-Control': 'no-cache, no-store',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        }));
      });

      res.on('error', (e) => { console.log(`[annotated] stream error: ${e.message}`); settle(new Response('Stream error', { status: 503 })); });
      res.resume();
    });

    req.on('error', (e) => { console.log(`[annotated] connection error: ${e.message}`); settle(new Response('Connection refused', { status: 503 })); });
    req.end();
  });
}
