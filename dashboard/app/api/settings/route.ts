import { NextResponse } from 'next/server';
import { readSettings, writeSettings } from '@/lib/settings';
import { applyHardwareModeToAll } from '@/lib/compose';

export async function GET() {
  try {
    const settings = readSettings();
    return NextResponse.json({ settings });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const prev = readSettings();
    const body = await request.json();
    writeSettings(body);
    if (body.hardwareMode && body.hardwareMode !== prev.hardwareMode) {
      applyHardwareModeToAll(body.hardwareMode);
    }
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
