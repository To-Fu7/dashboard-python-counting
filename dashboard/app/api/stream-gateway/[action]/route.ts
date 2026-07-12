import { NextResponse } from 'next/server';
import {
  composeUpStreamGateway,
  composeStopStreamGateway,
  composeRestartStreamGateway,
  composeBuildStreamGateway,
} from '@/lib/compose';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ action: string }> }
) {
  const { action } = await params;
  try {
    switch (action) {
      case 'start':
        await composeUpStreamGateway();
        return NextResponse.json({ success: true });
      case 'stop':
        await composeStopStreamGateway();
        return NextResponse.json({ success: true });
      case 'restart':
        await composeRestartStreamGateway();
        return NextResponse.json({ success: true });
      case 'build': {
        const { stdout, stderr } = await composeBuildStreamGateway();
        return NextResponse.json({ success: true, output: `${stdout}\n${stderr}`.trim() });
      }
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
