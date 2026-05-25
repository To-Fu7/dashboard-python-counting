'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { StatusBadge } from '@/components/StatusBadge';
import { RefreshCw, Maximize2, Loader2, ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import { toast } from 'sonner';
import type { ContainerStatus } from '@/lib/types';

interface Device {
  deviceCode: string;
  deviceName: string;
  containerName: string;
  rtspUrl: string;
  status: ContainerStatus;
  env?: Record<string, string>;
}

type GridLayout = '1' | '2x2' | '3x3' | 'auto';

function parseLinesFromEnv(env: Record<string, string>): Array<{ p1: [number, number]; p2: [number, number] }> {
  const lines: Array<{ p1: [number, number]; p2: [number, number] }> = [];
  for (const letter of 'ACEGIKMOQSUWY') {
    const val = env[`line${letter}`];
    if (!val) break;
    try {
      const parsed = JSON.parse(val.replace(/\(/g, '[').replace(/\)/g, ']').replace(/'/g, '"'));
      if (Array.isArray(parsed) && parsed.length === 2) {
        lines.push({ p1: parsed[0] as [number, number], p2: parsed[1] as [number, number] });
      }
    } catch { /* skip */ }
  }
  return lines;
}

function parseResolution(res: string | undefined): [number, number] {
  if (!res) return [800, 600];
  try {
    const parsed = JSON.parse(res.replace(/\(/g, '[').replace(/\)/g, ']'));
    if (Array.isArray(parsed) && parsed.length === 2) return [parsed[0], parsed[1]];
  } catch { /* fallback */ }
  return [800, 600];
}

const LINE_COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899'];

function parseZonesFromEnv(env: Record<string, string>): Array<Array<[number, number]>> {
  const zones: Array<Array<[number, number]>> = [];
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const val = env[`zone${letter}`];
    if (!val) break;
    try {
      const parsed = JSON.parse(val.replace(/\(/g, '[').replace(/\)/g, ']').replace(/'/g, '"'));
      if (Array.isArray(parsed) && parsed.length >= 3) zones.push(parsed as Array<[number, number]>);
    } catch { /* skip */ }
  }
  return zones;
}

function drawZoneOverlay(ctx: CanvasRenderingContext2D, zones: Array<Array<[number, number]>>) {
  zones.forEach((pts, i) => {
    const color = LINE_COLORS[i % LINE_COLORS.length];
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    pts.slice(1).forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.closePath();
    ctx.fillStyle = `${color}40`;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.restore();
  });
}

function drawLineOverlay(
  ctx: CanvasRenderingContext2D,
  lines: Array<{ p1: [number, number]; p2: [number, number] }>,
  offsetAxis: string,
  offsetAmount: number,
) {
  lines.forEach(({ p1, p2 }, i) => {
    const color = LINE_COLORS[i % LINE_COLORS.length];
    const off1: [number, number] = offsetAxis === 'X' ? [p1[0] + offsetAmount, p1[1]] : [p1[0], p1[1] + offsetAmount];
    const off2: [number, number] = offsetAxis === 'X' ? [p2[0] + offsetAmount, p2[1]] : [p2[0], p2[1] + offsetAmount];

    ctx.save();
    ctx.strokeStyle = '#fcd34d';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(off1[0], off1[1]);
    ctx.lineTo(off2[0], off2[1]);
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(p1[0], p1[1]);
    ctx.lineTo(p2[0], p2[1]);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`Gate ${i + 1}`, (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2 - 8);
  });
}

function StreamCell({ device }: { device: Device }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [streamLoaded, setStreamLoaded] = useState(false);
  const [streamError, setStreamError] = useState(false);
  const [counts, setCounts] = useState<{ in: number; out: number } | null>(null);
  const resolution = parseResolution(device.env?.SCREEN_RESOLUTION);
  const detectionMode = device.env?.DETECTION_MODE || 'line_crossing';
  const lines = detectionMode === 'line_crossing' && device.env
    ? parseLinesFromEnv(device.env as Record<string, string>) : [];
  const zones = detectionMode === 'zone' && device.env
    ? parseZonesFromEnv(device.env as Record<string, string>) : [];
  const offsetAxis = device.env?.LINE_OFFSET ?? 'Y';
  const offsetAmount = parseInt(device.env?.LINE_OFFSET_AMOUNT ?? '5', 10);

  useEffect(() => {
    const load = () => {
      fetch(`/api/devices/${device.deviceCode}/counts`)
        .then(r => r.json())
        .then(d => setCounts({ in: d.in ?? 0, out: d.out ?? 0 }))
        .catch(() => {});
    };
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [device.deviceCode]);

  // Draw overlay ONCE on canvas — only when lines/zones change, not per frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (detectionMode === 'line_crossing' && lines.length > 0) {
      drawLineOverlay(ctx, lines, offsetAxis, offsetAmount);
    } else if (detectionMode === 'zone' && zones.length > 0) {
      drawZoneOverlay(ctx, zones);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines.length, zones.length, detectionMode, offsetAxis, offsetAmount]);

  if (device.status !== 'running') {
    return (
      <div className="relative bg-black rounded-lg overflow-hidden aspect-video">
        <div className="flex flex-col items-center justify-center h-full text-gray-500 gap-2">
          <div className="w-10 h-10 rounded-full bg-gray-800 flex items-center justify-center">
            <span className="text-lg text-gray-600">&#9654;</span>
          </div>
          <p className="text-xs">Service not running</p>
        </div>
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="text-white text-xs font-medium truncate">{device.deviceName}</span>
            <StatusBadge status={device.status} />
          </div>
        </div>
        <div className="absolute top-2 left-2">
          <span className="text-xs font-mono text-white/70 bg-black/50 rounded px-1.5 py-0.5">{device.deviceCode}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="relative bg-black rounded-lg overflow-hidden aspect-video group">
      {!streamError ? (
        <>
          {/* Native MJPEG stream — browser handles frame decoding, no JS per-frame overhead */}
          <img
            src={`/api/stream/${device.deviceCode}?fps=3&q=12`}
            className="absolute inset-0 w-full h-full object-contain"
            onLoad={() => setStreamLoaded(true)}
            onError={() => setStreamError(true)}
            alt=""
          />
          {/* Static canvas overlay for detection lines/zones — redrawn only when config changes */}
          <canvas
            ref={canvasRef}
            width={resolution[0]}
            height={resolution[1]}
            className="absolute inset-0 w-full h-full pointer-events-none"
          />
          {!streamLoaded && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/70">
              <Loader2 className="w-6 h-6 text-white/50 animate-spin" />
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-col items-center justify-center h-full text-gray-500 gap-2">
          <div className="w-10 h-10 rounded-full bg-gray-800 flex items-center justify-center">
            <span className="text-lg text-gray-600">&#9654;</span>
          </div>
          <p className="text-xs">Stream unavailable</p>
        </div>
      )}

      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-white text-xs font-medium truncate">{device.deviceName}</span>
          {detectionMode === 'line_crossing' ? (
            <div className="flex items-center gap-2 shrink-0">
              <span className="flex items-center gap-1 text-green-400 text-xs font-bold tabular-nums">
                <ArrowDownToLine className="w-3 h-3" />
                {counts?.in ?? '—'}
              </span>
              <span className="flex items-center gap-1 text-orange-400 text-xs font-bold tabular-nums">
                <ArrowUpFromLine className="w-3 h-3" />
                {counts?.out ?? '—'}
              </span>
            </div>
          ) : (
            <span className="text-blue-400 text-xs font-bold tabular-nums shrink-0">
              {counts ? `${counts.in} entered` : '—'}
            </span>
          )}
        </div>
      </div>

      <div className="absolute top-2 left-2">
        <span className="text-xs font-mono text-white/70 bg-black/50 rounded px-1.5 py-0.5">
          {device.deviceCode}
        </span>
      </div>
    </div>
  );
}

export default function StreamPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [layout, setLayout] = useState<GridLayout>('auto');

  const fetchDevices = useCallback(async () => {
    try {
      const res = await fetch('/api/devices');
      const data = await res.json();
      const devs: Device[] = data.devices || [];

      const withEnv = await Promise.all(
        devs.map(async (d) => {
          try {
            const r = await fetch(`/api/devices/${d.deviceCode}`);
            const dd = await r.json();
            return { ...d, env: dd.env };
          } catch {
            return d;
          }
        })
      );
      setDevices(withEnv);
    } catch {
      toast.error('Failed to fetch devices');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  const gridClass: Record<GridLayout, string> = {
    '1': 'grid-cols-1 max-w-3xl mx-auto',
    '2x2': 'grid-cols-2',
    '3x3': 'grid-cols-3',
    'auto': devices.length === 1 ? 'grid-cols-1 max-w-3xl mx-auto'
          : devices.length <= 4 ? 'grid-cols-2'
          : 'grid-cols-3',
  };

  return (
    <div className="p-3 space-y-2 h-full flex flex-col">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-xl font-semibold">Stream</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {loading ? 'Loading...' : `${devices.length} camera${devices.length !== 1 ? 's' : ''}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={layout} onValueChange={v => v && setLayout(v as GridLayout)}>
            <SelectTrigger className="w-28">
              <Maximize2 className="w-3.5 h-3.5 mr-2 shrink-0" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto</SelectItem>
              <SelectItem value="1">1×1</SelectItem>
              <SelectItem value="2x2">2×2</SelectItem>
              <SelectItem value="3x3">3×3</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={fetchDevices} disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {!loading && devices.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          No cameras configured.
        </div>
      ) : (
        <div className={`grid gap-1.5 flex-1 ${gridClass[layout]}`}>
          {devices.map(device => (
            <StreamCell key={device.deviceCode} device={device} />
          ))}
        </div>
      )}
    </div>
  );
}
