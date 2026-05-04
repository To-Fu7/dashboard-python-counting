import { NextResponse } from 'next/server';
import { getContainerLogs } from '@/lib/docker';
import { listServices, getContainerName } from '@/lib/compose';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const containerCode = url.searchParams.get('container');
  const tail = parseInt(url.searchParams.get('tail') || '200', 10);
  const since = url.searchParams.get('since');

  try {
    const services = listServices();
    const targets = containerCode
      ? services.filter(s => s.deviceCode === containerCode)
      : services;

    const allLogs: { containerCode: string; containerName: string; line: string }[] = [];

    await Promise.all(
      targets.map(async s => {
        const containerName = getContainerName(s.deviceCode);
        const logs = await getContainerLogs(
          containerName,
          tail,
          since ? parseInt(since, 10) : undefined
        );
        for (const line of logs) {
          allLogs.push({ containerCode: s.deviceCode, containerName, line });
        }
      })
    );

    return NextResponse.json({ logs: allLogs });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
