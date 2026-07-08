// Helpers for talking to the Triton Inference Server HTTP API (port 8000) and
// its Prometheus metrics endpoint (port 8002). The dashboard container shares
// the `envisions` network with Triton, so the container name resolves directly;
// TRITON_HTTP_URL / TRITON_METRICS_URL override for non-docker dev runs.

const TRITON_HTTP_URL = process.env.TRITON_HTTP_URL || 'http://triton-inference-server:8000';
const TRITON_METRICS_URL = process.env.TRITON_METRICS_URL || 'http://triton-inference-server:8002';

const FETCH_TIMEOUT_MS = 3000;

async function tritonFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${TRITON_HTTP_URL}${path}`, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: 'no-store',
  });
}

export interface TritonModelIndexEntry {
  name: string;
  version?: string;
  state?: string;   // 'READY' | 'UNAVAILABLE' | ...
  reason?: string;
}

export interface TritonHealth {
  reachable: boolean;
  ready: boolean;
}

export async function getHealth(): Promise<TritonHealth> {
  try {
    const res = await tritonFetch('/v2/health/ready');
    return { reachable: true, ready: res.ok };
  } catch {
    return { reachable: false, ready: false };
  }
}

export async function getRepositoryIndex(): Promise<TritonModelIndexEntry[]> {
  const res = await tritonFetch('/v2/repository/index', { method: 'POST' });
  if (!res.ok) throw new Error(`repository/index failed: ${res.status}`);
  return (await res.json()) as TritonModelIndexEntry[];
}

export async function getModelConfig(name: string): Promise<Record<string, unknown>> {
  const res = await tritonFetch(`/v2/models/${encodeURIComponent(name)}/config`);
  if (!res.ok) throw new Error(`model config failed: ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

interface TritonMetadataTensor {
  name: string;
  datatype: string;
  shape: number[];
}

export async function getModelMetadata(name: string): Promise<{ inputs: TritonMetadataTensor[]; outputs: TritonMetadataTensor[] }> {
  const res = await tritonFetch(`/v2/models/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`model metadata failed: ${res.status}`);
  return (await res.json()) as { inputs: TritonMetadataTensor[]; outputs: TritonMetadataTensor[] };
}

/** Embed a face crop (already resized/normalized to CHW float32) via Triton's
 *  HTTP v2 inference API. Input/output tensor names and shape are discovered
 *  from model metadata (same auto-detect approach as the Python TritonEmbedClient)
 *  rather than hardcoded, so this works with any ArcFace-shaped model. */
export async function embedFace(modelName: string, chwFloatData: Float32Array, shape: [number, number, number, number]): Promise<number[]> {
  const meta = await getModelMetadata(modelName);
  const input = meta.inputs[0];
  const output = meta.outputs[0];
  if (!input || !output) throw new Error(`Model '${modelName}' has no inputs/outputs in its metadata`);

  const res = await tritonFetch(`/v2/models/${encodeURIComponent(modelName)}/infer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputs: [{ name: input.name, shape, datatype: 'FP32', data: Array.from(chwFloatData) }],
      outputs: [{ name: output.name }],
    }),
  });
  if (!res.ok) throw new Error(`ArcFace inference failed: ${res.status} ${await res.text()}`);

  const json = (await res.json()) as { outputs: { name: string; data: number[] }[] };
  const out = json.outputs.find(o => o.name === output.name) ?? json.outputs[0];
  if (!out) throw new Error('ArcFace inference response had no outputs');
  return out.data;
}

export async function loadModel(name: string): Promise<void> {
  const res = await tritonFetch(`/v2/repository/models/${encodeURIComponent(name)}/load`, { method: 'POST' });
  if (!res.ok) throw new Error(`model load failed: ${res.status} ${await res.text()}`);
}

export async function unloadModel(name: string): Promise<void> {
  const res = await tritonFetch(`/v2/repository/models/${encodeURIComponent(name)}/unload`, { method: 'POST' });
  if (!res.ok) throw new Error(`model unload failed: ${res.status} ${await res.text()}`);
}

export interface TritonMetrics {
  inferenceCount: number;       // nv_inference_count (all models)
  requestSuccess: number;       // nv_inference_request_success
  requestFailure: number;       // nv_inference_request_failure
  queueTimeUs: number;          // nv_inference_queue_duration_us (cumulative)
  computeTimeUs: number;        // nv_inference_compute_infer_duration_us (cumulative)
}

function sumMetric(text: string, name: string): number {
  let total = 0;
  const re = new RegExp(`^${name}\\{[^}]*\\}\\s+([0-9.eE+-]+)$`, 'gm');
  for (const m of text.matchAll(re)) total += parseFloat(m[1]);
  return total;
}

export async function getMetrics(): Promise<TritonMetrics | null> {
  try {
    const res = await fetch(`${TRITON_METRICS_URL}/metrics`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const text = await res.text();
    return {
      inferenceCount: sumMetric(text, 'nv_inference_count'),
      requestSuccess: sumMetric(text, 'nv_inference_request_success'),
      requestFailure: sumMetric(text, 'nv_inference_request_failure'),
      queueTimeUs: sumMetric(text, 'nv_inference_queue_duration_us'),
      computeTimeUs: sumMetric(text, 'nv_inference_compute_infer_duration_us'),
    };
  } catch {
    return null;
  }
}
