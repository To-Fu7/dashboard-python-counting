import { NextResponse } from 'next/server';
import { readDeviceEnv } from '@/lib/env-parser';
import { Client } from 'pg';

export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const env = readDeviceEnv(code);

  if (!env?.DEVICE_ID || !env?.PG_HOST) {
    return NextResponse.json({ in: 0, out: 0 });
  }

  const client = new Client({
    host: env.PG_HOST,
    port: parseInt(env.PG_PORT || '5432', 10),
    database: env.PG_DB,
    user: env.PG_USER,
    password: env.PG_PASS,
    connectionTimeoutMillis: 3000,
  });

  try {
    await client.connect();
    const res = await client.query(
      `SELECT COALESCE(total_in, 0) AS total_in, COALESCE(total_out, 0) AS total_out
       FROM person_inout
       WHERE device_id = $1
         AND created_at::date = CURRENT_DATE
       ORDER BY created_at DESC
       LIMIT 1`,
      [env.DEVICE_ID],
    );
    const row = res.rows[0] ?? { total_in: 0, total_out: 0 };
    return NextResponse.json({ in: Number(row.total_in), out: Number(row.total_out) });
  } catch (e) {
    return NextResponse.json({ in: 0, out: 0, error: String(e) });
  } finally {
    await client.end().catch(() => {});
  }
}
