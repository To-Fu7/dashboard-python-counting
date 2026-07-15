import { NextResponse } from 'next/server';
import { findPortConflict } from '@/lib/portforward';

// Backs the device Stream tab's "Check availability" action — a registry-based
// check that the port is inside the published 5500-5600 range and not already
// used by another device's PORTFWD_LISTEN_PORT, NOT a live OS-level socket probe.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const port = new URL(request.url).searchParams.get('port');
  if (!port) {
    return NextResponse.json({ error: 'port query param required' }, { status: 400 });
  }
  const conflict = findPortConflict(port, code);
  return NextResponse.json({ available: !conflict, conflict });
}
