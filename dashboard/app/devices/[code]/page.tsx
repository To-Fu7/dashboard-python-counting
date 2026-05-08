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
import { LineDrawer } from '@/components/LineDrawer';
import { ZoneDrawer, type DrawnZone } from '@/components/ZoneDrawer';
import { Play, Square, RotateCcw, ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import type { DeviceEnvConfig, ContainerStatus } from '@/lib/types';

interface DrawnLine { label: string; p1: { x: number; y: number }; p2: { x: number; y: number } }

function envZonesToDrawn(env: Partial<DeviceEnvConfig>): DrawnZone[] {
  const zones: DrawnZone[] = [];
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const val = env[`zone${letter}`];
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

function drawnZonesToEnv(zones: DrawnZone[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const zone of zones) {
    result[`zone${zone.label}`] = `[${zone.points.map(p => `(${p.x}, ${p.y})`).join(', ')}]`;
  }
  return result;
}

function parseResolution(res: string | undefined): [number, number] {
  if (!res) return [800, 600];
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
    if (tab) setActiveTab(tab);
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

  const fetchDevice = useCallback(async () => {
    try {
      const res = await fetch(`/api/devices/${code}`);
      if (res.status === 404) { router.push('/devices'); return; }
      const data = await res.json();
      setEnv(data.env);
      setStatus(data.status);
      setLines(envLinesToDrawn(data.env));
      setZones(envZonesToDrawn(data.env));
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
      for (const letter of 'ACEGIKMOQSUWY') clearLines[`line${letter}`] = undefined;
      for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') clearZones[`zone${letter}`] = undefined;

      const payload = mode === 'line_crossing'
        ? { ...env, ...clearZones, ...clearLines, ...drawnLinesToEnv(lines) }
        : { ...env, ...clearLines, ...clearZones, ...drawnZonesToEnv(zones) };

      const res = await fetch(`/api/devices/${code}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success('Settings saved. Restart service to apply changes.');
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
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="basic">Basic Settings</TabsTrigger>
          <TabsTrigger value="lines">Line Configuration</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
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

          <Section title="Stream">
            <FormField label="RTSP URL">
              <Input value={env.RTSP_URL || ''} onChange={e => setField('RTSP_URL', e.target.value)} placeholder="rtsp://..." />
            </FormField>
          </Section>

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
            </div>
          </Section>

          <Section title="Video">
            <div className="grid grid-cols-2 gap-4">
              <FormField label="Screen Resolution">
                <Select value={env.SCREEN_RESOLUTION || '[800, 600]'} onValueChange={v => v && setField('SCREEN_RESOLUTION', v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="[800, 600]">800 × 600</SelectItem>
                    <SelectItem value="[1024, 768]">1024 × 768</SelectItem>
                    <SelectItem value="[1280, 720]">1280 × 720</SelectItem>
                    <SelectItem value="[1920, 1080]">1920 × 1080</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label="Detection Margin (px)">
                <Input type="number" value={env.DETECTION_MARGIN || '30'} onChange={e => setField('DETECTION_MARGIN', e.target.value)} />
              </FormField>
              <FormField label="FPS Limit (0 = unlimited)">
                <Input type="number" value={env.FPS_LIMIT || '0'} onChange={e => setField('FPS_LIMIT', e.target.value)} />
              </FormField>
              <FormField label="Frame Skip">
                <Input type="number" value={env.FRAME_SKIP || '2'} onChange={e => setField('FRAME_SKIP', e.target.value)} />
              </FormField>
            </div>
          </Section>

          <Section title="YOLO Model">
            <div className="grid grid-cols-2 gap-4">
              <FormField label="Model File">
                <Input value={env.YOLO_MODEL || 'yolo11n.pt'} onChange={e => setField('YOLO_MODEL', e.target.value)} />
              </FormField>
              <FormField label="Confidence (0.0–1.0)">
                <Input type="number" step="0.05" min="0" max="1" value={env.YOLO_CONFIDENCE || '0.3'} onChange={e => setField('YOLO_CONFIDENCE', e.target.value)} />
              </FormField>
              <FormField label="Outbound JPEG Quality (1–100)">
                <Input type="number" min="1" max="100" value={env.JPEG_QUALITY || '40'} onChange={e => setField('JPEG_QUALITY', e.target.value)} />
              </FormField>
              <FormField label="NVDEC (GPU Hardware Decoding)">
                <div className="flex items-center gap-2 pt-2">
                  <Switch
                    checked={env.ENABLE_NVDEC === 'true'}
                    onCheckedChange={v => setField('ENABLE_NVDEC', v ? 'true' : 'false')}
                  />
                  <span className="text-sm text-muted-foreground">{env.ENABLE_NVDEC === 'true' ? 'Enabled' : 'Disabled'}</span>
                </div>
              </FormField>
            </div>
          </Section>

          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save Settings'}
            </Button>
          </div>
        </TabsContent>

        {/* ── LINE CONFIGURATION ── */}
        <TabsContent value="lines" className="space-y-6 pt-4">
          <Section title="Detection Mode">
            <div className="flex gap-3">
              {(['line_crossing', 'zone'] as const).map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setField('DETECTION_MODE', m)}
                  className={`px-4 py-2 rounded-md text-sm border transition-colors ${
                    (env.DETECTION_MODE || 'line_crossing') === m
                      ? 'border-primary bg-primary/10 text-primary font-medium'
                      : 'border-border text-muted-foreground hover:bg-accent'
                  }`}
                >
                  {m === 'line_crossing' ? 'Line Crossing' : 'Zone Detection'}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-1.5">
              Modes are exclusive. Switching mode clears the other mode&apos;s configuration on save.
            </p>
          </Section>

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
                  initialLines={lines}
                  offsetAxis={env.LINE_OFFSET || 'Y'}
                  offsetAmount={parseInt(env.LINE_OFFSET_AMOUNT || '5', 10)}
                  onChange={setLines}
                />
              </Section>
            </>
          ) : (
            <Section title="Zone Drawing">
              <ZoneDrawer
                deviceCode={code}
                resolution={parseResolution(env.SCREEN_RESOLUTION)}
                initialZones={zones}
                onChange={setZones}
              />
            </Section>
          )}

          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save Settings'}
            </Button>
          </div>
        </TabsContent>

        {/* ── LOGS ── */}
        <TabsContent value="logs" className="pt-4 space-y-4">
          {status === 'running' && (
            <Section title="Live Stream">
              <StreamPreview code={code} />
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

function StreamPreview({ code }: { code: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [connecting, setConnecting] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    setConnecting(true);
    setError(false);

    const es = new EventSource(`/api/stream/${code}`);
    let drawPending = false;

    es.onmessage = (event) => {
      if (drawPending) return;
      drawPending = true;
      setConnecting(false);
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        drawPending = false;
      };
      img.src = `data:image/jpeg;base64,${event.data}`;
    };

    es.onerror = () => { setError(true); es.close(); };

    return () => es.close();
  }, [code]);

  return (
    <div className="relative bg-black rounded-lg overflow-hidden aspect-video max-h-52">
      <canvas ref={canvasRef} width={800} height={600} className="w-full h-full" />
      {connecting && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70">
          <Loader2 className="w-5 h-5 text-white/40 animate-spin" />
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70">
          <p className="text-xs text-gray-400">Stream unavailable</p>
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
