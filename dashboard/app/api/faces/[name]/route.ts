import { NextResponse } from 'next/server';
import { deleteKnownFacesByName } from '@/lib/face-db';

export async function DELETE(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  try {
    const deleted = await deleteKnownFacesByName(decodeURIComponent(name));
    if (deleted === 0) {
      return NextResponse.json({ error: `No known_faces rows for '${name}'` }, { status: 404 });
    }
    return NextResponse.json({ success: true, deleted });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
