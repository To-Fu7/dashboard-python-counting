import { NextResponse } from 'next/server';
import { composeBuild } from '@/lib/compose';

export async function POST() {
  try {
    const { stdout, stderr } = await composeBuild();
    return NextResponse.json({ success: true, stdout, stderr });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
