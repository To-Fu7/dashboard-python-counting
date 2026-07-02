import { NextResponse } from 'next/server';
import { getContainerStatus } from '@/lib/docker';
import { TRITON_CONTAINER_NAME } from '@/lib/compose';
import { getHealth, getRepositoryIndex, getMetrics } from '@/lib/triton';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [containerStatus, health, metrics] = await Promise.all([
      getContainerStatus(TRITON_CONTAINER_NAME).catch(() => 'unknown' as const),
      getHealth(),
      getMetrics(),
    ]);

    let models: Awaited<ReturnType<typeof getRepositoryIndex>> = [];
    if (health.ready) {
      try {
        models = await getRepositoryIndex();
      } catch {
        // server ready but repository index unavailable — leave empty
      }
    }

    return NextResponse.json({
      containerName: TRITON_CONTAINER_NAME,
      containerStatus,
      reachable: health.reachable,
      ready: health.ready,
      models,
      metrics,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
