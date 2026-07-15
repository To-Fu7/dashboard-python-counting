'use client';

import { useEffect, useState, useCallback, useRef, use } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StatusBadge } from '@/components/StatusBadge';
import { ModelSelect } from '@/components/ModelSelect';
import { TagSelect } from '@/components/TagSelect';
import { LineDrawer } from '@/components/LineDrawer';
import { ZoneDrawer, type DrawnZone, type ZoneLayer } from '@/components/ZoneDrawer';
import type { CropRect } from '@/lib/types';
import { Play, Square, RotateCcw, ArrowLeft, Loader2, ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import type { DeviceEnvConfig, ContainerStatus } from '@/lib/types';
import { EDGE_MODE } from '@/lib/edge-mode';

interface DrawnLine { label: string; p1: { x: number; y: number }; p2: { x: number; y: number } }

/** prefix: 'zone' for person-counting zones, 'apdZone'/'faceZone' for the
 *  independent APD/Face restriction zones (same lettered-suffix env scheme,
 *  see counting_config.load_zones_from_env on the Python side). */
function envZonesToDrawn(env: Partial<DeviceEnvConfig>, prefix = 'zone'): DrawnZone[] {
  const zones: DrawnZone[] = [];
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const val = env[`${prefix}${letter}`];
    if (!val) break;
    try {
      const parsed = JSON.parse(val.replace(/\(/g, '[').replace(/\)/g, ']').replace(/'/g, '"'));
      if (Array.isArray(parsed) && parsed.length >= 3) {
        zones.push({ label: letter, points: parsed.map(([x, y]: [number, number]) => ({ x, y })) });
      }
    } catch { /* skip malformed */ }
  }
  return zones;
}

function drawnZonesToEnv(zones: DrawnZone[], prefix = 'zone'): Record<string, string> {
  const result: Record<string, string> = {};
  for (const zone of zones) {
    result[`${prefix}${zone.label}`] = `[${zone.points.map(p => `(${p.x}, ${p.y})`).join(', ')}]`;
  }
  return result;
}

function envToCropRect(env: Partial<DeviceEnvConfig>): CropRect | null {
  const val = env.CROP_AREA;
  if (!val) return null;
  try {
    const parsed = JSON.parse(val.replace(/\(/g, '[').replace(/\)/g, ']').replace(/'/g, '"'));
    return { x1: parsed[0][0], y1: parsed[0][1], x2: parsed[1][0], y2: parsed[1][1] };
  } catch { return null; }
}

function cropRectToEnv(c: CropRect): string {
  return `[(${c.x1}, ${c.y1}), (${c.x2}, ${c.y2})]`;
}

function isAutoResolution(res: string | undefined): boolean {
  return (res ?? '').trim().toLowerCase() === 'auto';
}

function parseResolution(res: string | undefined): [number, number] {
  // 'auto' has no fixed pixel size to parse — this is just the placeholder
  // canvas size used until LineDrawer/ZoneDrawer auto-detect the real one
  // from the live stream/capture image (see autoDetectResolution prop).
  if (!res || isAutoResolution(res)) return [1920, 1080];
  try {
    const parsed = JSON.parse(res.replace(/\(/g, '[').replace(/\)/g, ']'));
    if (Array.isArray(parsed) && parsed.length === 2) return [parsed[0], parsed[1]];
  } catch { /* fallback */ }
  return [800, 600];
}

function envLinesToDrawn(env: Partial<DeviceEnvConfig>): DrawnLine[] {
  const lines: DrawnLine[] = [];
  const letters = 'ACEGIKMOQSUWY';
  for (const letter of letters) {
    const val = env[`line${letter}`];
    if (!val) break;
    try {
      const parsed = JSON.parse(val.replace(/\(/g, '[').replace(/\)/g, ']').replace(/'/g, '"'));
      if (Array.isArray(parsed) && parsed.length === 2) {
        lines.push({
          label: letter,
          p1: { x: parsed[0][0], y: parsed[0][1] },
          p2: { x: parsed[1][0], y: parsed[1][1] },
        });
      }
    } catch { /* skip malformed */ }
  }
  return lines;
}

function drawnLinesToEnv(lines: DrawnLine[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of lines) {
    result[`line${line.label}`] = `[(${line.p1.x}, ${line.p1.y}), (${line.p2.x}, ${line.p2.y})]`;
  }
  return result;
}

export default function DeviceDetailPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const router = useRouter();

  const [activeTab, setActiveTab] = useState('basic');
  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get('tab');
    // Ignore stale/bookmarked links into tabs this mode doesn't render.
    if (tab && !(EDGE_MODE && (tab === 'lines' || tab === 'logs'))) setActiveTab(tab);
  }, []);

  const [env, setEnv] = useState<Partial<DeviceEnvConfig>>({});
  const [status, setStatus] = useState<ContainerStatus>('unknown');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [liveStreaming, setLiveStreaming] = useState(false);
  const logScrollRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<DrawnLine[]>([]);
  const [zones, setZones] = useState<DrawnZone[]>([]);
  const [apdZones, setApdZones] = useState<DrawnZone[]>([]);
  const [faceZones, setFaceZones] = useState<DrawnZone[]>([]);
  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [tritonModels, setTritonModels] = useState<{ name: string; state: string }[]>([]);

  useEffect(() => {
    fetch('/api/triton/models')
      .then(r => r.json())
      .then(d => { if (d.models) setTritonModels(d.models); })
      .catch(() => { /* Triton model list unavailable — keep free-text fallback */ });
  }, []);

  const fetchDevice = useCallback(async () => {
    try {
      const res = await fetch(`/api/devices/${code}`);
      if (res.status === 404) { router.push('/devices'); return; }
      const data = await res.json();
      setEnv(data.env);
      setStatus(data.status);
      setLines(envLinesToDrawn(data.env));
      setZones(envZonesToDrawn(data.env));
      setApdZones(envZonesToDrawn(data.env, 'apdZone'));
      setFaceZones(envZonesToDrawn(data.env, 'faceZone'));
      setCropRect(envToCropRect(data.env));
    } catch {
      toast.error('Failed to load device');
    } finally {
      setLoading(false);
    }
  }, [code, router]);

  useEffect(() => {
    fetchDevice();
  }, [fetchDevice]);

  useEffect(() => {
    setLogs([]);
    setLiveStreaming(false);
    if (status !== 'running') return;

    const es = new EventSource(`/api/devices/${code}/logs/stream?tail=150`);
    setLiveStreaming(true);

    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (typeof parsed === 'object' && parsed !== null) {
          if (parsed.__eof) { setLiveStreaming(false); es.close(); }
          return;
        }
        setLogs(prev => {
          const next = [...prev, String(parsed)];
          return next.length > 500 ? next.slice(-500) : next;
        });
        setTimeout(() => {
          if (logScrollRef.current) {
            logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
          }
        }, 10);
      } catch { /* ignore parse errors */ }
    };

    es.onerror = () => { setLiveStreaming(false); es.close(); };

    return () => { es.close(); setLiveStreaming(false); };
  }, [status, code]);

  function setField(key: string, value: string) {
    setEnv(prev => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    const mode = env.DETECTION_MODE || 'line_crossing';

    if (mode === 'line_crossing' && lines.length === 0) {
      toast.error('At least one detection line is required before saving.');
      return;
    }
    if (mode === 'zone' && zones.length === 0) {
      toast.error('At least one detection zone is required before saving.');
      return;
    }

    setSaving(true);
    try {
      // Clear vars for the inactive mode
      const clearLines: Record<string, undefined> = {};
      const clearZones: Record<string, undefined> = {};
      const clearApdZones: Record<string, undefined> = {};
      const clearFaceZones: Record<string, undefined> = {};
      for (const letter of 'ACEGIKMOQSUWY') clearLines[`line${letter}`] = undefined;
      for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        clearZones[`zone${letter}`] = undefined;
        clearApdZones[`apdZone${letter}`] = undefined;
        clearFaceZones[`faceZone${letter}`] = undefined;
      }

      const cropEnv = { CROP_AREA: cropRect ? cropRectToEnv(cropRect) : '' };
      // APD/Face restriction zones are independent of DETECTION_MODE, so they're
      // always re-written (cleared first, then re-set from current drawing state)
      // regardless of which branch below runs.
      const apdFaceZonesEnv = {
        ...clearApdZones, ...clearFaceZones,
        ...drawnZonesToEnv(apdZones, 'apdZone'),
        ...drawnZonesToEnv(faceZones, 'faceZone'),
      };

      const payload = mode === 'line_crossing'
        ? { ...env, ...cropEnv, ...clearZones, ...clearLines, ...drawnLinesToEnv(lines), ...apdFaceZonesEnv }
        : { ...env, ...cropEnv, ...clearLines, ...clearZones, ...drawnZonesToEnv(zones), ...apdFaceZonesEnv };

      const res = await fetch(`/api/devices/${code}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      // The env was saved regardless; the port-forward nginx deploy is a
      // separate step that can fail on its own — surface that instead of a
      // blanket "saved" that hides a forward never reaching nginx. `skipped`
      // means the feature is simply off (no nginx container configured).
      const pf = data.portForward;
      if (pf && !pf.deployed && !pf.skipped) {
        toast.warning(`Settings saved, but port-forward deploy failed: ${pf.error}`);
      } else {
        toast.success('Settings saved. Restart service to apply changes.');
      }
    } catch (e) {
      toast.error(`Failed to save: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  async function containerAction(action: 'start' | 'stop' | 'restart') {
    setActionLoading(action);
    try {
      const res = await fetch(`/api/devices/${code}/${action}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(`${action.charAt(0).toUpperCase() + action.slice(1)}ed`);
      setTimeout(() => { fetchDevice(); }, 1500);
    } catch (e) {
      toast.error(`Failed to ${action}: ${e}`);
    } finally {
      setActionLoading('');
    }
  }

  if (loading) {
    return <div className="p-6 text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div className="flex items-center gap-4">
        <Link href="/devices">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="w-4 h-4 mr-2" /> Devices
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{env.DEVICE_NAME || code}</h1>
          <p className="text-xs text-muted-foreground font-mono">{code}</p>
        </div>
        {!EDGE_MODE && (
        <>
        <StatusBadge status={status} />
        <div className="flex gap-1.5">
          {status !== 'running' ? (
            <Button size="sm" onClick={() => containerAction('start')} disabled={!!actionLoading}>
              <Play className="w-3.5 h-3.5 mr-1.5" />
              {actionLoading === 'start' ? 'Starting...' : 'Start'}
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => containerAction('stop')} disabled={!!actionLoading}>
              <Square className="w-3.5 h-3.5 mr-1.5" />
              {actionLoading === 'stop' ? 'Stopping...' : 'Stop'}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => containerAction('restart')} disabled={!!actionLoading}>
            <RotateCcw className="w-3.5 h-3.5 mr-1" />
            {actionLoading === 'restart' ? '...' : 'Restart'}
          </Button>
        </div>
        </>
        )}
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="basic">Basic Settings</TabsTrigger>
          {!EDGE_MODE && <TabsTrigger value="lines">Line Configuration</TabsTrigger>}
          <TabsTrigger value="stream">Stream</TabsTrigger>
          {!EDGE_MODE && <TabsTrigger value="logs">Logs</TabsTrigger>}
        </TabsList>

        {/* ── BASIC SETTINGS ── */}
        <TabsContent value="basic" className="space-y-6 pt-4">
          <Section title="Device Identity">
            <div className="grid grid-cols-2 gap-4">
              <FormField label="Device ID">
                <Input value={env.DEVICE_ID || ''} onChange={e => setField('DEVICE_ID', e.target.value)} />
              </FormField>
              <FormField label="Device Name">
                <Input value={env.DEVICE_NAME || ''} onChange={e => setField('DEVICE_NAME', e.target.value)} />
              </FormField>
              <FormField label="Device Code" hint="No spaces">
                <Input value={env.DEVICE_CODE || ''} onChange={e => setField('DEVICE_CODE', e.target.value.replace(/\s/g, '_').toUpperCase())} />
              </FormField>
            </div>
          </Section>

          <Section title="Camera Source">
            <FormField label="RTSP URL">
              <Input value={env.RTSP_URL || ''} onChange={e => setField('RTSP_URL', e.target.value)} placeholder="rtsp://..." />
            </FormField>
          </Section>

          {!EDGE_MODE && (
          <>
          <Section title="MQTT Topics">
            <div className="grid grid-cols-2 gap-4">
              <FormField label="Activity Topic">
                <Input value={env.MQTT_TOPIC || ''} onChange={e => setField('MQTT_TOPIC', e.target.value)} />
              </FormField>
              <FormField label="Interval Topic">
                <Input value={env.MQTT_INTERVAL_TOPIC || ''} onChange={e => setField('MQTT_INTERVAL_TOPIC', e.target.value)} />
              </FormField>
              <FormField label="Interval Minutes">
                <Input type="number" value={env.MQTT_INTERVAL_MINUTES || '5'} onChange={e => setField('MQTT_INTERVAL_MINUTES', e.target.value)} />
              </FormField>
              <FormField label="Daily Send Time">
                <Input value={env.DAILY_SEND_TIME || '23:59'} onChange={e => setField('DAILY_SEND_TIME', e.target.value)} placeholder="23:59" />
              </FormField>
              <FormField label="APD Topic">
                <Input value={env.MQTT_APD_TOPIC || ''} onChange={e => setField('MQTT_APD_TOPIC', e.target.value)} />
              </FormField>
              <FormField label="Fire/Smoke Topic">
                <Input value={env.MQTT_FIRESMOKE_TOPIC || ''} onChange={e => setField('MQTT_FIRESMOKE_TOPIC', e.target.value)} />
              </FormField>
              <FormField label="Face Topic">
                <Input value={env.MQTT_FACE_TOPIC || ''} onChange={e => setField('MQTT_FACE_TOPIC', e.target.value)} />
              </FormField>
            </div>
          </Section>

          <Section title="Video">
            <div className="grid grid-cols-2 gap-4">
              <FormField label="Screen Resolution">
                <Select value={env.SCREEN_RESOLUTION || '[800, 600]'} onValueChange={v => v && setField('SCREEN_RESOLUTION', v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto (camera native)</SelectItem>
                    <SelectItem value="[800, 600]">800 × 600</SelectItem>
                    <SelectItem value="[1024, 768]">1024 × 768</SelectItem>
                    <SelectItem value="[1280, 720]">1280 × 720</SelectItem>
                    <SelectItem value="[1920, 1080]">1920 × 1080 (Full HD)</SelectItem>
                    <SelectItem value="[2560, 1440]">2560 × 1440 (QHD)</SelectItem>
                    <SelectItem value="[3840, 2160]">3840 × 2160 (4K UHD)</SelectItem>
                  </SelectContent>
                </Select>
                {isAutoResolution(env.SCREEN_RESOLUTION) && (
                  <p className="text-xs text-muted-foreground mt-1.5">
                    No resize step — every frame is processed at the camera&apos;s own resolution.
                    Best pixel density for detection (esp. Face on high-res sources), but heavier
                    on CPU decode/GPU inference than a fixed lower resolution.
                  </p>
                )}
              </FormField>
              <FormField label="FPS Limit (0 = unlimited)">
                <Input type="number" value={env.FPS_LIMIT || '0'} onChange={e => setField('FPS_LIMIT', e.target.value)} />
              </FormField>
              <FormField label="Frame Skip">
                <Input type="number" value={env.FRAME_SKIP || '2'} onChange={e => setField('FRAME_SKIP', e.target.value)} />
              </FormField>
            </div>
          </Section>

          <Section title="Detection Mode">
            <FormField label="Mode">
              <Select value={env.DETECTION_MODE || 'line_crossing'} onValueChange={v => v && setField('DETECTION_MODE', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="line_crossing">Line Crossing</SelectItem>
                  <SelectItem value="zone">Zone Detection</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1.5">
                Modes are exclusive. Switching mode clears the other mode&apos;s configuration on save.
              </p>
            </FormField>
          </Section>

          <Section title="Detection Model (Triton)">
            <div className="grid grid-cols-2 gap-4">
              <FormField label="Triton Model">
                <ModelSelect
                  value={env.TRITON_MODEL || ''}
                  onChange={v => setField('TRITON_MODEL', v)}
                  placeholder="yolo26m_640 (Triton model repository name)"
                  models={tritonModels}
                />
              </FormField>
              <FormField label="Confidence (0.0–1.0)">
                <Input type="number" step="0.05" min="0" max="1" value={env.YOLO_CONFIDENCE || '0.3'} onChange={e => setField('YOLO_CONFIDENCE', e.target.value)} />
              </FormField>
              <FormField label="Outbound JPEG Quality (1–100)">
                <Input type="number" min="1" max="100" value={env.JPEG_QUALITY || '40'} onChange={e => setField('JPEG_QUALITY', e.target.value)} />
              </FormField>
              <FormField label="Annotated Stream (Bounding Box)">
                <div className="flex items-center gap-2 pt-2">
                  <Switch
                    checked={env.ANNOTATED_STREAM === 'true'}
                    onCheckedChange={v => setField('ANNOTATED_STREAM', v ? 'true' : 'false')}
                  />
                  <span className="text-sm text-muted-foreground">
                    {env.ANNOTATED_STREAM === 'true' ? 'Enabled — bounding boxes visible on device detail' : 'Disabled — plain stream only (lower CPU)'}
                  </span>
                </div>
              </FormField>
            </div>
          </Section>

          <Section title="Additional Detection">
            <div className="space-y-5">
              <div className="space-y-3 rounded-md border border-border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">APD (PPE Violation) Detection</span>
                  <Switch
                    checked={env.APD_ENABLED === 'true'}
                    onCheckedChange={v => setField('APD_ENABLED', v ? 'true' : 'false')}
                  />
                </div>
                {env.APD_ENABLED === 'true' && (
                  <div className="grid grid-cols-2 gap-4">
                    <FormField label="Model">
                      <ModelSelect
                        value={env.APD_MODEL || ''}
                        onChange={v => setField('APD_MODEL', v)}
                        placeholder="apd_640"
                        models={tritonModels}
                      />
                    </FormField>
                    <FormField label="Confidence (0.0–1.0)">
                      <Input type="number" step="0.05" min="0" max="1" value={env.APD_CONFIDENCE || '0.3'} onChange={e => setField('APD_CONFIDENCE', e.target.value)} />
                    </FormField>
                    <FormField label="Tag">
                      <TagSelect value={env.APD_TAG || 'alarm'} onChange={v => setField('APD_TAG', v)} />
                    </FormField>
                  </div>
                )}
              </div>

              <div className="space-y-3 rounded-md border border-border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Fire &amp; Smoke Detection</span>
                  <Switch
                    checked={env.FIRE_SMOKE_ENABLED === 'true'}
                    onCheckedChange={v => setField('FIRE_SMOKE_ENABLED', v ? 'true' : 'false')}
                  />
                </div>
                {env.FIRE_SMOKE_ENABLED === 'true' && (
                  <div className="grid grid-cols-2 gap-4">
                    <FormField label="Model">
                      <ModelSelect
                        value={env.FIRE_SMOKE_MODEL || ''}
                        onChange={v => setField('FIRE_SMOKE_MODEL', v)}
                        placeholder="fire_smoke_640"
                        models={tritonModels}
                      />
                    </FormField>
                    <FormField label="Confidence (0.0–1.0)">
                      <Input type="number" step="0.05" min="0" max="1" value={env.FIRE_SMOKE_CONFIDENCE || '0.3'} onChange={e => setField('FIRE_SMOKE_CONFIDENCE', e.target.value)} />
                    </FormField>
                    <FormField label="Fire Tag">
                      <TagSelect value={env.FIRE_TAG || 'alarm'} onChange={v => setField('FIRE_TAG', v)} />
                    </FormField>
                    <FormField label="Smoke Tag">
                      <TagSelect value={env.SMOKE_TAG || 'alarm'} onChange={v => setField('SMOKE_TAG', v)} />
                    </FormField>
                    <FormField label="Cooldown (minutes)">
                      <Input type="number" min="1" value={env.FIRE_SMOKE_COOLDOWN_MINUTES || '5'} onChange={e => setField('FIRE_SMOKE_COOLDOWN_MINUTES', e.target.value)} />
                    </FormField>
                  </div>
                )}
              </div>

              <div className="space-y-3 rounded-md border border-border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Face Detection (Insider/Intruder)</span>
                  <Switch
                    checked={env.FACE_ENABLED === 'true'}
                    onCheckedChange={v => setField('FACE_ENABLED', v ? 'true' : 'false')}
                  />
                </div>
                {env.FACE_ENABLED === 'true' && (
                  <div className="grid grid-cols-2 gap-4">
                    <FormField label="Face Detector Model">
                      <ModelSelect
                        value={env.FACE_MODEL || ''}
                        onChange={v => setField('FACE_MODEL', v)}
                        placeholder="face_640"
                        models={tritonModels}
                      />
                    </FormField>
                    <FormField label="Face Embedding Model">
                      <ModelSelect
                        value={env.FACE_EMBED_MODEL || ''}
                        onChange={v => setField('FACE_EMBED_MODEL', v)}
                        placeholder="arcface_112"
                        models={tritonModels}
                      />
                    </FormField>
                    <FormField label="Confidence (0.0–1.0)">
                      <Input type="number" step="0.05" min="0" max="1" value={env.FACE_CONFIDENCE || '0.5'} onChange={e => setField('FACE_CONFIDENCE', e.target.value)} />
                    </FormField>
                    <FormField label="Match Threshold (0.0–1.0)">
                      <Input type="number" step="0.05" min="0" max="1" value={env.FACE_MATCH_THRESHOLD || '0.5'} onChange={e => setField('FACE_MATCH_THRESHOLD', e.target.value)} />
                    </FormField>
                    <FormField label="Insider Tag">
                      <TagSelect value={env.INSIDER_TAG || 'info'} onChange={v => setField('INSIDER_TAG', v)} />
                    </FormField>
                    <FormField label="Intruder Tag">
                      <TagSelect value={env.INTRUDER_TAG || 'alarm'} onChange={v => setField('INTRUDER_TAG', v)} />
                    </FormField>
                    <FormField label="Cache Refresh (minutes)">
                      <Input type="number" min="1" value={env.FACE_CACHE_REFRESH_MINUTES || '10'} onChange={e => setField('FACE_CACHE_REFRESH_MINUTES', e.target.value)} />
                    </FormField>
                    <FormField label="Best-Shot Capture Frames">
                      <Input type="number" min="1" value={env.FACE_CAPTURE_FRAMES || '5'} onChange={e => setField('FACE_CAPTURE_FRAMES', e.target.value)} />
                      <p className="text-xs text-muted-foreground mt-1">
                        Sightings buffered per track before embedding the sharpest/best-lit/most
                        confident one — higher = better selection but longer verdict delay.
                      </p>
                    </FormField>
                  </div>
                )}
              </div>
            </div>
          </Section>
          </>
          )}

          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save Settings'}
            </Button>
          </div>
        </TabsContent>

        {/* ── LINE CONFIGURATION ── */}
        {!EDGE_MODE && (
        <TabsContent value="lines" className="space-y-6 pt-4">
          {(env.DETECTION_MODE || 'line_crossing') === 'line_crossing' ? (
            <>
              <Section title="Detection Behavior">
                <div className="grid grid-cols-2 gap-4">
                  <FormField label="Merge Gates">
                    <div className="flex items-center gap-2 pt-2">
                      <Switch
                        checked={env.MERGE_GATES === 'true'}
                        onCheckedChange={v => setField('MERGE_GATES', v ? 'true' : 'false')}
                      />
                      <span className="text-xs text-muted-foreground">Treat all gates as one detection zone</span>
                    </div>
                  </FormField>
                  <FormField label="Swap In/Out Direction">
                    <div className="flex items-center gap-2 pt-2">
                      <Switch
                        checked={env.SWAP_IN_OUT === 'true'}
                        onCheckedChange={v => setField('SWAP_IN_OUT', v ? 'true' : 'false')}
                      />
                      <span className="text-xs text-muted-foreground">Swap which crossing direction counts as IN</span>
                    </div>
                  </FormField>
                  <FormField label="Detection Style">
                    <Select value={env.DETECTION_STYLE || 'dot'} onValueChange={v => v && setField('DETECTION_STYLE', v)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="dot">DOT (center point)</SelectItem>
                        <SelectItem value="line">LINE (bounding box edge)</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormField>
                  <FormField label="Detection Point Axis">
                    <Select value={env.POINT_AXIS || 'Y'} onValueChange={v => v && setField('POINT_AXIS', v)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Y">Y (top/bottom)</SelectItem>
                        <SelectItem value="X">X (left/right)</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormField>
                  <FormField label="DOT Offset Axis">
                    <Select value={env.DOT_OFFSET || 'Y'} onValueChange={v => v && setField('DOT_OFFSET', v)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Y">Y</SelectItem>
                        <SelectItem value="X">X</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormField>
                  <FormField label="DOT Offset Value">
                    <Input type="number" value={env.DOT_OFFSET_AMOUNT || '0'} onChange={e => setField('DOT_OFFSET_AMOUNT', e.target.value)} />
                  </FormField>
                  <FormField label="Line Offset Axis">
                    <Select value={env.LINE_OFFSET || 'Y'} onValueChange={v => v && setField('LINE_OFFSET', v)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Y">Y</SelectItem>
                        <SelectItem value="X">X</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormField>
                  <FormField label="Line Offset Amount (OUT line gap)">
                    <Input type="number" value={env.LINE_OFFSET_AMOUNT || '5'} onChange={e => setField('LINE_OFFSET_AMOUNT', e.target.value)} />
                  </FormField>
                </div>
              </Section>

              <Section title="Line Drawing">
                <LineDrawer
                  deviceCode={code}
                  containerStatus={status}
                  resolution={parseResolution(env.SCREEN_RESOLUTION)}
                  autoDetectResolution={isAutoResolution(env.SCREEN_RESOLUTION)}
                  initialLines={lines}
                  offsetAxis={env.LINE_OFFSET || 'Y'}
                  offsetAmount={parseInt(env.LINE_OFFSET_AMOUNT || '5', 10)}
                  onChange={setLines}
                  cropRect={cropRect}
                  onCropChange={setCropRect}
                />
              </Section>
            </>
          ) : null}

          {(() => {
            const zoneMode = (env.DETECTION_MODE || 'line_crossing') === 'zone';
            const zoneLayers: ZoneLayer[] = [
              ...(zoneMode ? [{ key: 'person', label: 'Person Zone', color: '#3b82f6', zones, onChange: setZones }] : []),
              ...(env.APD_ENABLED === 'true'
                ? [{ key: 'apd', label: 'APD Zone', color: '#f59e0b', zones: apdZones, onChange: setApdZones }]
                : []),
              ...(env.FACE_ENABLED === 'true'
                ? [{ key: 'face', label: 'Face Zone', color: '#10b981', zones: faceZones, onChange: setFaceZones }]
                : []),
            ];
            if (zoneLayers.length === 0) return null;

            return (
              <Section title="Zone Drawing">
                {!zoneMode && (env.APD_ENABLED === 'true' || env.FACE_ENABLED === 'true') && (
                  <p className="text-xs text-muted-foreground -mt-2 mb-1">
                    APD/Face zones are optional restrictions, independent of Detection Mode (currently
                    Line Crossing) — leave empty for no restriction (whole crop area).
                  </p>
                )}
                <ZoneDrawer
                  deviceCode={code}
                  resolution={parseResolution(env.SCREEN_RESOLUTION)}
                  autoDetectResolution={isAutoResolution(env.SCREEN_RESOLUTION)}
                  layers={zoneLayers}
                  cropRect={cropRect}
                  onCropChange={zoneMode ? setCropRect : undefined}
                />
              </Section>
            );
          })()}

          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save Settings'}
            </Button>
          </div>
        </TabsContent>
        )}

        {/* ── STREAM (MSE/HLS/WebRTC + Port Forward) ── */}
        <TabsContent value="stream" className="space-y-6 pt-4">
          <StreamSettingsTab code={code} env={env} setField={setField} />

          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save Settings'}
            </Button>
          </div>
        </TabsContent>

        {/* ── LOGS ── */}
        {!EDGE_MODE && (
        <TabsContent value="logs" className="pt-4 space-y-4">
          {status === 'running' && (
            <Section title="Live Stream">
              <StreamPreview code={code} env={env} />
            </Section>
          )}
          <Section title="Service Logs">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                {liveStreaming ? (
                  <span className="flex items-center gap-1.5 text-xs text-green-400">
                    <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse inline-block" />
                    Live
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {status !== 'running' ? 'Container not running' : 'Connecting...'}
                  </span>
                )}
              </div>
              <Button size="sm" variant="ghost" onClick={() => setLogs([])}>Clear</Button>
            </div>
            <div
              ref={logScrollRef}
              className="h-96 rounded border border-border bg-black/90 p-3 overflow-y-auto"
            >
              {logs.length === 0 ? (
                <p className="text-xs text-gray-500">
                  {status === 'running' ? 'Waiting for logs...' : 'No logs available.'}
                </p>
              ) : (
                <div className="space-y-0.5">
                  {logs.map((line, i) => (
                    <LogLine key={i} line={line} />
                  ))}
                </div>
              )}
            </div>
          </Section>
        </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">{title}</h3>
      {children}
    </div>
  );
}

function FormField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </div>
  );
}

interface StreamUrlSet { hls: string; mse: string; webrtc: string }

function StreamSettingsTab({
  code, env, setField,
}: {
  code: string;
  env: Partial<DeviceEnvConfig>;
  setField: (key: string, value: string) => void;
}) {
  const [urls, setUrls] = useState<{ main: StreamUrlSet; sub: StreamUrlSet | null } | null>(null);
  const [urlsLoading, setUrlsLoading] = useState(false);
  const [portCheck, setPortCheck] = useState<{ available: boolean; conflict: string | null } | null>(null);
  const [portChecking, setPortChecking] = useState(false);

  async function exposeUrls() {
    setUrlsLoading(true);
    try {
      const res = await fetch(`/api/devices/${code}/stream-urls`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setUrls(data);
    } catch (e) {
      toast.error(`Failed to fetch stream URLs: ${e}`);
    } finally {
      setUrlsLoading(false);
    }
  }

  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
    toast.success('Copied');
  }

  async function checkPort() {
    const port = env.PORTFWD_LISTEN_PORT;
    if (!port) { toast.error('Enter a listen port first'); return; }
    setPortChecking(true);
    try {
      const res = await fetch(`/api/devices/${code}/port-check?port=${encodeURIComponent(port)}`);
      const data = await res.json();
      setPortCheck(data);
    } catch (e) {
      toast.error(`Check failed: ${e}`);
    } finally {
      setPortChecking(false);
    }
  }

  function suggestPort() {
    // Client-side starting point only, inside the 5500-5600 range published by
    // the edge-portfwd-nginx container — "Check availability" confirms it
    // server-side against the real registry.
    setField('PORTFWD_LISTEN_PORT', String(5500 + Math.floor(Math.random() * 101)));
    setPortCheck(null);
  }

  return (
    <>
      <Section title="Live Stream Server">
        <div className="grid grid-cols-2 gap-4">
          <FormField label="Connection Mode">
            <div className="flex items-center gap-2 pt-2">
              <Switch
                checked={env.STREAM_GATEWAY_ALWAYS_ON === 'true'}
                onCheckedChange={v => setField('STREAM_GATEWAY_ALWAYS_ON', v ? 'true' : 'false')}
              />
              <span className="text-sm text-muted-foreground">
                {env.STREAM_GATEWAY_ALWAYS_ON === 'true'
                  ? 'Always-on — connects immediately, reconnects automatically'
                  : 'On-demand — connects on first viewer, disconnects after an idle period'}
              </span>
            </div>
          </FormField>
          <FormField label="Include Audio">
            <div className="flex items-center gap-2 pt-2">
              <Switch
                checked={env.STREAM_GATEWAY_AUDIO === 'true'}
                onCheckedChange={v => setField('STREAM_GATEWAY_AUDIO', v ? 'true' : 'false')}
              />
              <span className="text-sm text-muted-foreground">
                {env.STREAM_GATEWAY_AUDIO === 'true' ? 'Enabled' : 'Disabled'}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              AAC/Opus sources only for HLS/MSE playback; WebRTC additionally needs Opus specifically.
              G.711 (PCM μ-law/A-law) cameras have no audio path on HLS/MSE and get no audio anywhere
              with this switch on.
            </p>
          </FormField>
          <div className="col-span-2">
            <FormField label="Substream URL (optional)">
              <Input
                value={env.SUBSTREAM_URL || ''}
                onChange={e => setField('SUBSTREAM_URL', e.target.value)}
                placeholder="rtsp://... (e.g. Hikvision Channel 102, lower resolution)"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Manual field only — registered as an independent stream (&quot;{code}_sub&quot;). No
                automatic switching between main/substream in the grid or fullscreen views.
              </p>
            </FormField>
          </div>
        </div>
      </Section>

      <Section title="Live Stream URLs">
        <Button type="button" variant="outline" size="sm" onClick={exposeUrls} disabled={urlsLoading}>
          {urlsLoading ? 'Loading...' : 'Expose CCTV URL'}
        </Button>
        {urls && (
          <div className="space-y-3 pt-2">
            <StreamUrlRow label="HLS" value={urls.main.hls} onCopy={copy} />
            <StreamUrlRow label="MSE" value={urls.main.mse} onCopy={copy} />
            <StreamUrlRow label="WebRTC" value={urls.main.webrtc} onCopy={copy} />
            {urls.sub && (
              <>
                <p className="text-xs text-muted-foreground pt-1">Substream</p>
                <StreamUrlRow label="HLS" value={urls.sub.hls} onCopy={copy} />
                <StreamUrlRow label="MSE" value={urls.sub.mse} onCopy={copy} />
                <StreamUrlRow label="WebRTC" value={urls.sub.webrtc} onCopy={copy} />
              </>
            )}
          </div>
        )}
      </Section>

      <Section title="Port Forward">
        <div className="space-y-3 rounded-md border border-border p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Raw TCP Port Forward (RTSP passthrough)</span>
            <Switch
              checked={env.PORTFWD_ENABLED === 'true'}
              onCheckedChange={v => setField('PORTFWD_ENABLED', v ? 'true' : 'false')}
            />
          </div>
          {env.PORTFWD_ENABLED === 'true' && (
            <div className="grid grid-cols-3 gap-4">
              <FormField label="Forward IP">
                <Input
                  value={env.PORTFWD_SRC_IP || ''}
                  onChange={e => setField('PORTFWD_SRC_IP', e.target.value)}
                  placeholder="10.11.0.48"
                />
              </FormField>
              <FormField label="Forward Port">
                <Input
                  value={env.PORTFWD_SRC_PORT ?? ''}
                  onChange={e => setField('PORTFWD_SRC_PORT', e.target.value)}
                  placeholder="554"
                />
              </FormField>
              <FormField label="Listen Port">
                <Input
                  value={env.PORTFWD_LISTEN_PORT || ''}
                  onChange={e => { setField('PORTFWD_LISTEN_PORT', e.target.value); setPortCheck(null); }}
                  placeholder="5546"
                />
              </FormField>
              <div className="col-span-3 flex items-center gap-2">
                <Button type="button" size="sm" variant="outline" onClick={checkPort} disabled={portChecking}>
                  {portChecking ? 'Checking...' : 'Check availability'}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={suggestPort}>
                  Suggest an open port
                </Button>
                {portCheck && (
                  <span className={`text-xs ${portCheck.available ? 'text-green-500' : 'text-red-400'}`}>
                    {portCheck.available ? 'Available' : portCheck.conflict}
                  </span>
                )}
              </div>
              <p className="col-span-3 text-xs text-muted-foreground">
                Listen Port must be in the range <span className="font-medium">5500&ndash;5600</span>,
                which the dedicated <span className="font-mono">edge-portfwd-nginx</span> container
                already publishes on the host. Availability is checked against ports this dashboard
                already forwards (other devices) — not a live OS-level socket probe. Applied on Save:
                the whole forwarder config is regenerated and reloaded, no container recreate needed.
              </p>
            </div>
          )}
        </div>
      </Section>
    </>
  );
}

function StreamUrlRow({ label, value, onCopy }: { label: string; value: string; onCopy: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-mono text-muted-foreground w-16 shrink-0">{label}</span>
      <Input readOnly value={value} className="font-mono text-xs" />
      <Button type="button" size="sm" variant="outline" onClick={() => onCopy(value)}>Copy</Button>
    </div>
  );
}

const LINE_COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6'];

function StreamPreview({ code, env }: { code: string; env: Partial<DeviceEnvConfig> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [counts, setCounts] = useState<{ in: number; out: number } | null>(null);

  const resolution = parseResolution(env.SCREEN_RESOLUTION);
  const detectionMode = env.DETECTION_MODE || 'line_crossing';

  const lines = (() => {
    if (detectionMode !== 'line_crossing') return [];
    const result: Array<{ p1: [number, number]; p2: [number, number] }> = [];
    for (const letter of 'ACEGIKMOQSUWY') {
      const val = env[`line${letter}`];
      if (!val) break;
      try {
        const p = JSON.parse(val.replace(/\(/g, '[').replace(/\)/g, ']').replace(/'/g, '"'));
        if (Array.isArray(p) && p.length === 2) result.push({ p1: p[0], p2: p[1] });
      } catch { /* skip */ }
    }
    return result;
  })();

  const zones = (() => {
    if (detectionMode !== 'zone') return [];
    const result: Array<Array<[number, number]>> = [];
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const val = env[`zone${letter}`];
      if (!val) break;
      try {
        const p = JSON.parse(val.replace(/\(/g, '[').replace(/\)/g, ']').replace(/'/g, '"'));
        if (Array.isArray(p) && p.length >= 3) result.push(p);
      } catch { /* skip */ }
    }
    return result;
  })();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const offsetAxis = env.LINE_OFFSET ?? 'Y';
    const offsetAmount = parseInt(env.LINE_OFFSET_AMOUNT ?? '5', 10);

    if (detectionMode === 'line_crossing' && lines.length > 0) {
      lines.forEach(({ p1, p2 }, i) => {
        const color = LINE_COLORS[i % LINE_COLORS.length];
        const off1: [number, number] = offsetAxis === 'X' ? [p1[0] + offsetAmount, p1[1]] : [p1[0], p1[1] + offsetAmount];
        const off2: [number, number] = offsetAxis === 'X' ? [p2[0] + offsetAmount, p2[1]] : [p2[0], p2[1] + offsetAmount];
        ctx.save();
        ctx.strokeStyle = '#fcd34d'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(off1[0], off1[1]); ctx.lineTo(off2[0], off2[1]); ctx.stroke();
        ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.stroke();
        ctx.fillStyle = color; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(`Gate ${i + 1}`, (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2 - 8);
        ctx.restore();
      });
    } else if (detectionMode === 'zone' && zones.length > 0) {
      zones.forEach((pts, i) => {
        const color = LINE_COLORS[i % LINE_COLORS.length];
        ctx.save();
        ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
        pts.slice(1).forEach(([x, y]) => ctx.lineTo(x, y));
        ctx.closePath();
        ctx.fillStyle = `${color}40`; ctx.fill();
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash([]); ctx.stroke();
        ctx.restore();
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines.length, zones.length, detectionMode, env.LINE_OFFSET, env.LINE_OFFSET_AMOUNT]);

  useEffect(() => {
    const load = () => {
      fetch(`/api/devices/${code}/counts`)
        .then(r => r.json())
        .then(d => setCounts({ in: d.in ?? 0, out: d.out ?? 0 }))
        .catch(() => {});
    };
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [code]);

  return (
    <div className="space-y-2">
      <div className="relative bg-black rounded-lg overflow-hidden aspect-video">
        {!error ? (
          <>
            <img
              src={env.ANNOTATED_STREAM === 'true' ? `/api/stream/${code}/annotated` : `/api/stream/${code}?plain=1`}
              className="absolute inset-0 w-full h-full object-contain"
              onLoad={() => setLoaded(true)}
              onError={() => setError(true)}
              alt=""
            />
            <canvas
              ref={canvasRef}
              width={resolution[0]}
              height={resolution[1]}
              className="absolute inset-0 w-full h-full pointer-events-none"
            />
            {!loaded && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/70">
                <Loader2 className="w-5 h-5 text-white/40 animate-spin" />
              </div>
            )}
          </>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 gap-1">
            <p className="text-xs text-gray-400">Stream unavailable</p>
            {env.ANNOTATED_STREAM === 'true' && (
              <p className="text-xs text-gray-600">Container not reachable on STREAM_PORT {env.STREAM_PORT ?? '8090'}</p>
            )}
          </div>
        )}
      </div>

      {detectionMode === 'line_crossing' ? (
        <div className="flex gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2">
            <ArrowDownToLine className="w-4 h-4 text-green-500" />
            <span className="text-xs text-muted-foreground">IN today</span>
            <span className="text-lg font-bold tabular-nums text-green-500">{counts?.in ?? '—'}</span>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2">
            <ArrowUpFromLine className="w-4 h-4 text-orange-500" />
            <span className="text-xs text-muted-foreground">OUT today</span>
            <span className="text-lg font-bold tabular-nums text-orange-500">{counts?.out ?? '—'}</span>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 w-fit">
          <span className="text-xs text-muted-foreground">Entered today</span>
          <span className="text-lg font-bold tabular-nums text-blue-500">{counts?.in ?? '—'}</span>
        </div>
      )}
    </div>
  );
}

function LogLine({ line }: { line: string }) {
  const isError = /error|exception|fatal/i.test(line);
  const isWarn = /warning|warn/i.test(line);

  return (
    <p className={`text-xs font-mono leading-5 ${
      isError ? 'text-red-400' : isWarn ? 'text-yellow-400' : 'text-gray-300'
    }`}>
      {line}
    </p>
  );
}
