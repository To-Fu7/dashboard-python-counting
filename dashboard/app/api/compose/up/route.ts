import { NextResponse } from 'next/server';
import { composeUpAll } from '@/lib/compose';

export async function POST() {
  try {
    await composeUpAll();
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
