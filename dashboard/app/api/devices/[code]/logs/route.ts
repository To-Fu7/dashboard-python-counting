import { NextResponse } from 'next/server';
import { getContainerLogs } from '@/lib/docker';
import { getContainerName } from '@/lib/compose';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const url = new URL(request.url);
  const tail = parseInt(url.searchParams.get('tail') || '200', 10);
  const since = url.searchParams.get('since');

  try {
    const containerName = getContainerName(code);
    const logs = await getContainerLogs(containerName, tail, since ? parseInt(since, 10) : undefined);
    return NextResponse.json({ logs });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
