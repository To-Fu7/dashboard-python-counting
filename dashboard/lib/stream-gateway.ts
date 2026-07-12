// Client for stream-gateway's management API (PUT/DELETE/GET /api/v1/cameras...).
// The dashboard container shares the `envisions` network with stream-gateway,
// so the container name resolves directly; STREAM_GATEWAY_URL overrides for
// non-docker dev runs. Mirrors dashboard/lib/triton.ts's pattern.
//
// Every call here is best-effort from the caller's point of view — if the
// stream-gateway container isn't up yet (or a camera hasn't been added to it
// yet), device add/edit/delete must not fail because of it. Callers should
// catch and log, not propagate, unless they specifically need the result
// (e.g. the "Expose CCTV URL" button does want the real error surfaced).

const STREAM_GATEWAY_URL = process.env.STREAM_GATEWAY_URL || 'http://stream-gateway:8555';

const FETCH_TIMEOUT_MS = 5000;

async function streamGatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${STREAM_GATEWAY_URL}${path}`, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: 'no-store',
  });
}

export interface CameraStreamConfig {
  rtspUrl: string;
  onDemand: boolean;
  includeAudio: boolean;
  idleTimeoutSeconds?: number;
}

export interface CameraStreamUrls {
  hls: string;
  mse: string;
  webrtc: string;
}

export interface CameraStreamStatus {
  code: string;
  state: string; // 'idle' | 'connecting' | 'ready' | 'error'
  onDemand: boolean;
  viewers: Record<string, number>;
  lastError?: string;
}

export async function upsertCameraStream(code: string, cfg: CameraStreamConfig): Promise<CameraStreamUrls> {
  const res = await streamGatewayFetch(`/api/v1/cameras/${encodeURIComponent(code)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rtspUrl: cfg.rtspUrl,
      onDemand: cfg.onDemand,
      includeAudio: cfg.includeAudio,
      idleTimeoutSeconds: cfg.idleTimeoutSeconds,
    }),
  });
  if (!res.ok) throw new Error(`stream-gateway upsert failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { urls: CameraStreamUrls };
  return body.urls;
}

export async function removeCameraStream(code: string): Promise<void> {
  const res = await streamGatewayFetch(`/api/v1/cameras/${encodeURIComponent(code)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    throw new Error(`stream-gateway remove failed: ${res.status} ${await res.text()}`);
  }
}

export async function getCameraStreamUrls(code: string): Promise<CameraStreamUrls> {
  const res = await streamGatewayFetch(`/api/v1/cameras/${encodeURIComponent(code)}/urls`);
  if (!res.ok) throw new Error(`stream-gateway urls fetch failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as CameraStreamUrls;
}

export async function listCameraStreams(): Promise<CameraStreamStatus[]> {
  const res = await streamGatewayFetch('/api/v1/cameras');
  if (!res.ok) throw new Error(`stream-gateway list failed: ${res.status}`);
  const body = (await res.json()) as { cameras: CameraStreamStatus[] };
  return body.cameras;
}

export interface StreamGatewayHealth {
  reachable: boolean;
}

export async function getHealth(): Promise<StreamGatewayHealth> {
  try {
    const res = await streamGatewayFetch('/api/v1/healthz');
    return { reachable: res.ok };
  } catch {
    return { reachable: false };
  }
}
