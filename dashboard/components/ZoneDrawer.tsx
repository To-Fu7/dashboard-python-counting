'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Undo2, Trash2, ImageIcon, Loader2 } from 'lucide-react';

interface Point { x: number; y: number }
export interface DrawnZone { label: string; points: Point[] }

interface ZoneDrawerProps {
  deviceCode: string;
  resolution?: [number, number];
  initialZones?: DrawnZone[];
  onChange: (zones: DrawnZone[]) => void;
}

const ZONE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
const SNAP_RADIUS = 20;

function getZoneLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

function zoneCentroid(points: Point[]): Point {
  const x = points.reduce((s, p) => s + p.x, 0) / points.length;
  const y = points.reduce((s, p) => s + p.y, 0) / points.length;
  return { x: Math.round(x), y: Math.round(y) };
}

export function ZoneDrawer({
  deviceCode,
  resolution = [800, 600],
  initialZones = [],
  onChange,
}: ZoneDrawerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const captureImgRef = useRef<HTMLImageElement | null>(null);
  const lastFrameRef = useRef<HTMLImageElement | null>(null);

  const [bgMode, setBgMode] = useState<'stream' | 'capture'>('stream');
  const [streamFailed, setStreamFailed] = useState(false);
  const [streamConnecting, setStreamConnecting] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [zones, setZones] = useState<DrawnZone[]>(initialZones);
  const [pendingPoints, setPendingPoints] = useState<Point[]>([]);
  const [mousePos, setMousePos] = useState<Point | null>(null);

  useEffect(() => {
    setZones(initialZones);
  }, [initialZones.length]); // eslint-disable-line react-hooks/exhaustive-deps

  function switchMode(mode: 'stream' | 'capture') {
    if (mode === 'stream') {
      setStreamFailed(false);
      setStreamConnecting(true);
      lastFrameRef.current = null;
    }
    setBgMode(mode);
  }

  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background
    if (bgMode === 'capture') {
      if (captureImgRef.current) {
        ctx.drawImage(captureImgRef.current, 0, 0, canvas.width, canvas.height);
      } else {
        ctx.fillStyle = '#1f2937';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#6b7280';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Capture a frame to start drawing zones', canvas.width / 2, canvas.height / 2);
      }
    } else {
      if (lastFrameRef.current) {
        ctx.drawImage(lastFrameRef.current, 0, 0, canvas.width, canvas.height);
      } else {
        ctx.fillStyle = '#1f2937';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    }

    // Completed zones
    zones.forEach((zone, i) => {
      if (zone.points.length < 2) return;
      const color = ZONE_COLORS[i % ZONE_COLORS.length];

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(zone.points[0].x, zone.points[0].y);
      zone.points.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = `${color}40`;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Label at centroid
      const c = zoneCentroid(zone.points);
      ctx.fillStyle = color;
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`Zone ${i + 1}`, c.x, c.y);

      // Vertex dots
      zone.points.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      });
      ctx.restore();
    });

    // In-progress polygon
    if (pendingPoints.length > 0) {
      const first = pendingPoints[0];

      // Lines between placed vertices
      ctx.save();
      ctx.strokeStyle = 'rgba(239,68,68,0.8)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      pendingPoints.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
      ctx.stroke();
      ctx.restore();

      // Preview line from last vertex to mouse
      if (mousePos && pendingPoints.length >= 1) {
        ctx.save();
        ctx.strokeStyle = 'rgba(239,68,68,0.5)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(pendingPoints[pendingPoints.length - 1].x, pendingPoints[pendingPoints.length - 1].y);
        ctx.lineTo(mousePos.x, mousePos.y);
        ctx.stroke();
        ctx.restore();
      }

      // Vertex dots
      pendingPoints.forEach((p, idx) => {
        ctx.beginPath();
        if (idx === 0) {
          // First vertex: larger with snap-target ring
          ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
          ctx.fillStyle = '#ef4444';
          ctx.fill();
          ctx.strokeStyle = 'white';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([]);
          ctx.stroke();

          if (pendingPoints.length >= 3) {
            // Show snap ring
            ctx.beginPath();
            ctx.arc(p.x, p.y, SNAP_RADIUS, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(239,68,68,0.4)';
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.stroke();
          }
        } else {
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fillStyle = '#ef4444';
          ctx.fill();
          ctx.strokeStyle = 'white';
          ctx.lineWidth = 1;
          ctx.setLineDash([]);
          ctx.stroke();
        }
      });

      // Hint text
      ctx.fillStyle = '#ef4444';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'left';
      ctx.setLineDash([]);
      if (pendingPoints.length < 3) {
        ctx.fillText(`Click to add point (${pendingPoints.length} placed, need 3+)`, first.x + 10, first.y - 8);
      } else {
        ctx.fillText('Click near first point to close zone', first.x + 10, first.y - 8);
      }
    }
  }, [zones, pendingPoints, mousePos, bgMode]);

  const drawCanvasRef = useRef(drawCanvas);
  useEffect(() => { drawCanvasRef.current = drawCanvas; }, [drawCanvas]);

  useEffect(() => { drawCanvas(); }, [drawCanvas]);

  // EventSource stream for Live Stream mode
  useEffect(() => {
    if (bgMode !== 'stream') return;

    const firstFrameSeen = { value: false };
    setStreamConnecting(true);
    setStreamFailed(false);
    lastFrameRef.current = null;

    const es = new EventSource(`/api/stream/${deviceCode}`);
    let drawPending = false;

    es.onmessage = (event) => {
      if (drawPending) return;
      drawPending = true;

      if (!firstFrameSeen.value) {
        firstFrameSeen.value = true;
        setStreamConnecting(false);
      }

      const img = new Image();
      img.onload = () => {
        lastFrameRef.current = img;
        drawCanvasRef.current();
        drawPending = false;
      };
      img.src = `data:image/jpeg;base64,${event.data}`;
    };

    es.onerror = () => {
      setStreamFailed(true);
      setStreamConnecting(false);
      es.close();
    };

    return () => {
      es.close();
      lastFrameRef.current = null;
    };
  }, [bgMode, deviceCode]);

  async function captureFrame() {
    setCapturing(true);
    setCaptureError(null);
    try {
      const res = await fetch(`/api/devices/${deviceCode}/capture`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      const img = new Image();
      img.onload = () => {
        captureImgRef.current = img;
        drawCanvasRef.current();
      };
      img.src = data.image;
    } catch (e) {
      setCaptureError(String(e));
    } finally {
      setCapturing(false);
    }
  }

  function getCanvasPoint(e: React.MouseEvent<HTMLCanvasElement>): Point {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - rect.left) * (canvas.width / rect.width)),
      y: Math.round((e.clientY - rect.top) * (canvas.height / rect.height)),
    };
  }

  function dist(a: Point, b: Point): number {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
  }

  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (bgMode === 'capture' && !captureImgRef.current) return;
    const pt = getCanvasPoint(e);

    // Snap-to-close: clicking near first vertex with >=3 points closes the polygon
    if (pendingPoints.length >= 3 && dist(pt, pendingPoints[0]) <= SNAP_RADIUS) {
      const newZone: DrawnZone = {
        label: getZoneLetter(zones.length),
        points: [...pendingPoints],
      };
      const updated = [...zones, newZone];
      setZones(updated);
      setPendingPoints([]);
      onChange(updated);
    } else {
      setPendingPoints(prev => [...prev, pt]);
    }
  }

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    setMousePos(getCanvasPoint(e));
  }

  function undo() {
    if (pendingPoints.length > 0) {
      setPendingPoints(prev => prev.slice(0, -1));
      return;
    }
    if (zones.length > 0) {
      const updated = zones.slice(0, -1);
      setZones(updated);
      onChange(updated);
    }
  }

  function clearAll() {
    setZones([]);
    setPendingPoints([]);
    onChange([]);
  }

  const canUndo = pendingPoints.length > 0 || zones.length > 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex rounded-md overflow-hidden border border-border text-xs">
          <button
            type="button"
            onClick={() => switchMode('stream')}
            className={`px-3 py-1.5 transition-colors ${bgMode === 'stream' ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-accent'}`}
          >
            Live Stream
          </button>
          <button
            type="button"
            onClick={() => switchMode('capture')}
            className={`px-3 py-1.5 border-l border-border transition-colors ${bgMode === 'capture' ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-accent'}`}
          >
            Capture
          </button>
        </div>

        {bgMode === 'capture' && (
          <Button variant="outline" size="sm" onClick={captureFrame} disabled={capturing}>
            <ImageIcon className="w-4 h-4 mr-2" />
            {capturing ? 'Capturing...' : 'Capture Frame'}
          </Button>
        )}

        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={undo} disabled={!canUndo}>
          <Undo2 className="w-4 h-4 mr-2" />
          Undo
        </Button>
        <Button variant="outline" size="sm" onClick={clearAll} disabled={zones.length === 0 && pendingPoints.length === 0}>
          <Trash2 className="w-4 h-4 mr-2" />
          Clear All
        </Button>
      </div>

      {captureError && bgMode === 'capture' && (
        <p className="text-xs text-destructive bg-destructive/10 rounded px-3 py-2">{captureError}</p>
      )}

      {streamFailed && bgMode === 'stream' && (
        <p className="text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/30 rounded px-3 py-2">
          Stream unavailable.{' '}
          <button className="underline font-medium" onClick={() => switchMode('capture')}>Switch to Capture mode</button>
          {' '}to use a static frame instead.
        </p>
      )}

      <div
        className="relative border border-border rounded-lg overflow-hidden bg-gray-900"
        style={{ aspectRatio: `${resolution[0]}/${resolution[1]}` }}
      >
        <canvas
          ref={canvasRef}
          width={resolution[0]}
          height={resolution[1]}
          className="w-full h-full cursor-crosshair"
          onClick={handleCanvasClick}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setMousePos(null)}
        />
        {bgMode === 'stream' && streamConnecting && !streamFailed && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 pointer-events-none">
            <Loader2 className="w-6 h-6 text-white/50 animate-spin" />
          </div>
        )}
      </div>

      <div className="text-xs text-muted-foreground space-y-0.5">
        <p>Click to place polygon vertices. Click near the first point (red circle) to close the zone.</p>
        <p>Multiple zones can be drawn — each zone fires an event when a person enters.</p>
      </div>

      {zones.length > 0 && (
        <div className="bg-muted/40 rounded p-3 space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Defined Zones</p>
          {zones.map((zone, i) => (
            <div key={i} className="flex items-center gap-2 text-xs font-mono">
              <span className="text-muted-foreground w-16">zone{zone.label}:</span>
              <span>{zone.points.length} vertices</span>
              <span className="text-muted-foreground">
                [{zone.points.map(p => `(${p.x},${p.y})`).join(', ')}]
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
