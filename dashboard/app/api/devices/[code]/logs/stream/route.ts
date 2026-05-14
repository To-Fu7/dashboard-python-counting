import { getContainerName } from '@/lib/compose';
import { getDocker } from '@/lib/docker';

export const dynamic = 'force-dynamic';

const MAX_STREAM_MS = 30 * 60 * 1000; // 30 minutes max per SSE connection

export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const url = new URL(request.url);
  const tail = parseInt(url.searchParams.get('tail') || '100', 10);
  const containerName = getContainerName(code);
  const encoder = new TextEncoder();

  let logStream: (NodeJS.ReadableStream & { destroy?: () => void }) | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;

  function cleanup() {
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    if (maxDurationTimer) { clearTimeout(maxDurationTimer); maxDurationTimer = null; }
    if (logStream) { logStream.destroy?.(); logStream = null; }
  }

  request.signal.addEventListener('abort', cleanup);

  const readable = new ReadableStream({
    async start(controller) {
      function send(text: string) {
        try { controller.enqueue(encoder.encode(text)); } catch { /* closed */ }
      }

      keepaliveTimer = setInterval(() => send(': ping\n\n'), 25000);
      maxDurationTimer = setTimeout(() => {
        cleanup();
        try { controller.close(); } catch { /* already closed */ }
      }, MAX_STREAM_MS);

      try {
        const docker = getDocker();
        const container = docker.getContainer(containerName);

        const stream = await container.logs({
          stdout: true,
          stderr: true,
          follow: true,
          timestamps: true,
          tail,
        }) as NodeJS.ReadableStream & { destroy?: () => void };

        logStream = stream;

        let pending = Buffer.alloc(0);
        let mode: 'detect' | 'multiplexed' | 'raw' = 'detect';

        stream.on('data', (chunk: Buffer) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          pending = Buffer.concat([pending, buf]);

          if (mode === 'detect') {
            if (pending.length >= 8 && pending[0] <= 2) {
              mode = 'multiplexed';
            } else if (pending.length > 0) {
              mode = 'raw';
            } else return;
          }

          if (mode === 'multiplexed') {
            while (pending.length >= 8) {
              if (pending[0] > 2) { mode = 'raw'; break; }
              const size = pending.readUInt32BE(4);
              if (pending.length < 8 + size) break;
              const payload = pending.subarray(8, 8 + size).toString('utf-8');
              pending = pending.subarray(8 + size);
              for (const line of payload.split('\n')) {
                if (line) send(`data: ${JSON.stringify(line)}\n\n`);
              }
            }
          }

          if (mode === 'raw') {
            const text = pending.toString('utf-8');
            pending = Buffer.alloc(0);
            for (const line of text.split('\n')) {
              if (line) send(`data: ${JSON.stringify(line)}\n\n`);
            }
          }
        });

        stream.on('end', () => {
          send('data: {"__eof":true}\n\n');
          cleanup();
          try { controller.close(); } catch { /* already closed */ }
        });

        stream.on('error', () => {
          cleanup();
          try { controller.close(); } catch { /* already closed */ }
        });

      } catch (e) {
        send(`data: ${JSON.stringify({ __error: String(e) })}\n\n`);
        cleanup();
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
