import { NextResponse } from 'next/server';
import { readDeviceEnv, writeDeviceEnv, deleteDeviceEnv } from '@/lib/env-parser';
import { removeService, serviceExists, getContainerName, composeStop } from '@/lib/compose';
import { getContainerStatus } from '@/lib/docker';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const env = readDeviceEnv(code);
  if (!env) {
    return NextResponse.json({ error: 'Device not found' }, { status: 404 });
  }
  const containerName = getContainerName(code);
  const status = await getContainerStatus(containerName);
  return NextResponse.json({ env, status, containerName });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  try {
    const body = await request.json();
    const existing = readDeviceEnv(code);
    if (!existing) {
      return NextResponse.json({ error: 'Device not found' }, { status: 404 });
    }

    const updated = { ...existing, ...body };
    writeDeviceEnv(code, updated);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  try {
    try {
      await composeStop(code);
    } catch {
      // Ignore stop errors (container may not exist)
    }

    if (serviceExists(code)) {
      removeService(code);
    }

    deleteDeviceEnv(code);

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
