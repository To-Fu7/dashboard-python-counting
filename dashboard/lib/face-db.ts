// Global known_faces access — this table is shared across every camera with
// FACE_ENABLED=true (not per-device like person_inout), so it connects using
// the global PostgreSQL settings (Settings page), not a specific device's env.
import { Client } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { readSettings } from './settings';

export interface KnownFace {
  id: string;
  person_name: string;
  variant_type: string;
  source_photo_path: string | null;
  created_at: string;
}

function getClient(): Client {
  const settings = readSettings();
  return new Client({
    host: settings.pg.host,
    port: parseInt(settings.pg.port || '5432', 10),
    database: settings.pg.db,
    user: settings.pg.user,
    password: settings.pg.pass,
    connectionTimeoutMillis: 5000,
  });
}

export async function insertKnownFace(
  personName: string,
  embedding: number[],
  variantType: string,
  sourcePhotoPath: string | null,
): Promise<string> {
  const client = getClient();
  try {
    await client.connect();
    const id = uuidv4();
    await client.query(
      `INSERT INTO known_faces (id, person_name, embedding, source_photo_path, variant_type)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, personName, embedding, sourcePhotoPath, variantType],
    );
    return id;
  } finally {
    await client.end().catch(() => {});
  }
}

export async function listKnownFaces(): Promise<KnownFace[]> {
  const client = getClient();
  try {
    await client.connect();
    const res = await client.query(
      `SELECT id, person_name, variant_type, source_photo_path, created_at
       FROM known_faces ORDER BY person_name, created_at`,
    );
    return res.rows as KnownFace[];
  } finally {
    await client.end().catch(() => {});
  }
}

export async function deleteKnownFacesByName(personName: string): Promise<number> {
  const client = getClient();
  try {
    await client.connect();
    const res = await client.query(`DELETE FROM known_faces WHERE person_name = $1`, [personName]);
    return res.rowCount ?? 0;
  } finally {
    await client.end().catch(() => {});
  }
}
