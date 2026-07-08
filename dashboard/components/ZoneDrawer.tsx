'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Undo2, Trash2, ImageIcon, Loader2, Crop } from 'lucide-react';
import type { CropRect } from '@/lib/types';

interface Point { x: number; y: number }
export interface DrawnZone { label: string; points: Point[] }

/** One independently-toggled set of zones sharing the same canvas/stream —
 *  e.g. person-counting zones, APD restriction zone, Face restriction zone.
 *  Only one layer is "active" (editable) at a time, but all layers' zones
 *  are drawn simultaneously so their relative positions stay visible. */
export interface ZoneLayer {
  key: string;
  label: string;
  color: string;
  zones: DrawnZone[];
  onChange: (zones: DrawnZone[]) => void;
}

interface ZoneDrawerProps {
  deviceCode: string;
  resolution?: [number, number];
  /** Single-layer usage (back-compat): a plain zones/onChange pair. */
  initialZones?: DrawnZone[];
  onChange?: (zones: DrawnZone[]) => void;
  /** Multi-layer usage: several independently-toggled zone sets on one shared
   *  stream/canvas instead of one ZoneDrawer per zone type. Takes precedence
   *  over initialZones/onChange when provided. */
  layers?: ZoneLayer[];
  cropRect?: CropRect | null;
  onCropChange?: (crop: CropRect | null) => void;
}

const DEFAULT_LAYER_KEY = '__default';
const ZONE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
const SNAP_RADIUS = 20;
const CROP_HANDLE = 8;

function getZoneLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

function zoneCentroid(points: Point[]): Point {
  const x = points.reduce((s, p) => s + p.x, 0) / points.length;
  const y = points.reduce((s, p) => s + p.y, 0) / points.length;
  return { x: Math.round(x), y: Math.round(y) };
}

function normalizeCrop(r: CropRect): CropRect {
  return {
    x1: Math.round(Math.min(r.x1, r.x2)),
    y1: Math.round(Math.min(r.y1, r.y2)),
    x2: Math.round(Math.max(r.x1, r.x2)),
    y2: Math.round(Math.max(r.y1, r.y2)),
  };
}

function clamp(v: number, min: number, max: number) { return Math.max(min, Math.min(max, v)); }

function getCropCorner(pt: Point, r: CropRect): 'tl' | 'tr' | 'bl' | 'br' | null {
  const h = CROP_HANDLE;
  if (Math.abs(pt.x - r.x1) <= h && Math.abs(pt.y - r.y1) <= h) return 'tl';
  if (Math.abs(pt.x - r.x2) <= h && Math.abs(pt.y - r.y1) <= h) return 'tr';
  if (Math.abs(pt.x - r.x1) <= h && Math.abs(pt.y - r.y2) <= h) return 'bl';
  if (Math.abs(pt.x - r.x2) <= h && Math.abs(pt.y - r.y2) <= h) return 'br';
  return null;
}

function insideCrop(pt: Point, r: CropRect): boolean {
  return pt.x >= r.x1 && pt.x <= r.x2 && pt.y >= r.y1 && pt.y <= r.y2;
}

export function ZoneDrawer({
  deviceCode,
  resolution = [800, 600],
  initialZones,
  onChange,
  layers: layersProp,
  cropRect = null,
  onCropChange,
}: ZoneDrawerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const captureImgRef = useRef<HTMLImageElement | null>(null);
  const streamImgRef = useRef<HTMLImageElement | null>(null);

  // Normalize single-layer (back-compat) usage into the same layers[] shape.
  const layers: ZoneLayer[] = layersProp ?? [{
    key: DEFAULT_LAYER_KEY, label: '', color: ZONE_COLORS[0],
    zones: initialZones ?? [], onChange: onChange ?? (() => {}),
  }];

  const [bgMode, setBgMode] = useState<'stream' | 'capture'>('stream');
  const [streamFailed, setStreamFailed] = useState(false);
  const [streamConnecting, setStreamConnecting] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [activeLayerKey, setActiveLayerKey] = useState(layers[0]?.key ?? DEFAULT_LAYER_KEY);
  const [pendingPoints, setPendingPoints] = useState<Point[]>([]);
  const [mousePos, setMousePos] = useState<Point | null>(null);

  // Crop state
  const [cropMode, setCropMode] = useState(false);
  const [localCrop, setLocalCrop] = useState<CropRect | null>(cropRect ?? null);
  const [cropDragging, setCropDragging] = useState(false);
  const cropDragRef = useRef<{
    type: 'draw' | 'move' | 'resize';
    corner?: 'tl' | 'tr' | 'bl' | 'br';
    startPt: Point;
    startCrop: CropRect;
  } | null>(null);

  // If the active layer disappears (e.g. its detector got disabled), fall
  // back to the first remaining layer instead of pointing at nothing.
  useEffect(() => {
    if (!layers.some(l => l.key === activeLayerKey)) {
      setActiveLayerKey(layers[0]?.key ?? DEFAULT_LAYER_KEY);
      setPendingPoints([]);
    }
  }, [layers, activeLayerKey]);

  useEffect(() => {
    setLocalCrop(cropRect ?? null);
  }, [cropRect]);

  const activeLayer = layers.find(l => l.key === activeLayerKey) ?? layers[0];

  function switchMode(mode: 'stream' | 'capture') {
    if (mode === 'stream') { setStreamFailed(false); setStreamConnecting(true); }
    setBgMode(mode);
  }

  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;

    ctx.clearRect(0, 0, W, H);

    if (bgMode === 'capture') {
      if (captureImgRef.current) {
        ctx.drawImage(captureImgRef.current, 0, 0, W, H);
      } else {
        ctx.fillStyle = '#1f2937';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#6b7280';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Capture a frame to start drawing zones', W / 2, H / 2);
      }
    }

    // Crop area overlay — rendered before zones so zones appear on top
    if (localCrop) {
      const { x1, y1, x2, y2 } = localCrop;

      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(0, 0, W, y1);
      ctx.fillRect(0, y2, W, H - y2);
      ctx.fillRect(0, y1, x1, y2 - y1);
      ctx.fillRect(x2, y1, W - x2, y2 - y1);
      ctx.restore();

      ctx.save();
      ctx.strokeStyle = 'rgba(0,255,255,0.75)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.restore();

      if (cropMode) {
        const corners: [number, number][] = [[x1, y1], [x2, y1], [x1, y2], [x2, y2]];
        for (const [cx, cy] of corners) {
          ctx.save();
          ctx.fillStyle = '#3b82f6';
          ctx.strokeStyle = 'white';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([]);
          ctx.fillRect(cx - CROP_HANDLE / 2, cy - CROP_HANDLE / 2, CROP_HANDLE, CROP_HANDLE);
          ctx.strokeRect(cx - CROP_HANDLE / 2, cy - CROP_HANDLE / 2, CROP_HANDLE, CROP_HANDLE);
          ctx.restore();
        }
      }

      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x1 + 4, y1 + 4, 68, 16);
      ctx.fillStyle = '#00ffff';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'left';
      ctx.setLineDash([]);
      ctx.fillText('Crop Area', x1 + 8, y1 + 14);
      ctx.restore();
    }

    // Completed zones — every layer drawn at once, each in its own color,
    // so relative position across zone types stays visible while editing one.
    layers.forEach(layer => {
      layer.zones.forEach((zone, i) => {
        if (zone.points.length < 2) return;
        const isActive = layer.key === activeLayerKey;

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(zone.points[0].x, zone.points[0].y);
        zone.points.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
        ctx.closePath();
        ctx.fillStyle = `${layer.color}${isActive ? '40' : '20'}`;
        ctx.fill();
        ctx.strokeStyle = layer.color;
        ctx.lineWidth = isActive ? 2 : 1.5;
        ctx.setLineDash(isActive ? [] : [4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);

        const c = zoneCentroid(zone.points);
        ctx.fillStyle = layer.color;
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(layer.label ? `${layer.label} ${i + 1}` : `Zone ${i + 1}`, c.x, c.y);

        zone.points.forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, isActive ? 4 : 3, 0, Math.PI * 2);
          ctx.fillStyle = layer.color;
          ctx.fill();
        });
        ctx.restore();
      });
    });

    // In-progress polygon (active layer only)
    if (pendingPoints.length > 0) {
      const first = pendingPoints[0];

      ctx.save();
      ctx.strokeStyle = 'rgba(239,68,68,0.8)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      pendingPoints.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
      ctx.stroke();
      ctx.restore();

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

      pendingPoints.forEach((p, idx) => {
        ctx.beginPath();
        if (idx === 0) {
          ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
          ctx.fillStyle = '#ef4444';
          ctx.fill();
          ctx.strokeStyle = 'white';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([]);
          ctx.stroke();
          if (pendingPoints.length >= 3) {
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
  }, [layers, activeLayerKey, pendingPoints, mousePos, bgMode, localCrop, cropMode]);

  useEffect(() => { drawCanvas(); }, [drawCanvas]);

  async function captureFrame() {
    setCapturing(true);
    setCaptureError(null);
    try {
      const res = await fetch(`/api/devices/${deviceCode}/capture`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const img = new Image();
      img.onload = () => { captureImgRef.current = img; drawCanvas(); };
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

  // ── Crop drag handlers ──────────────────────────────────────────────────────

  function handleMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!cropMode) return;
    const pt = getCanvasPoint(e);
    if (localCrop) {
      const corner = getCropCorner(pt, localCrop);
      if (corner) {
        cropDragRef.current = { type: 'resize', corner, startPt: pt, startCrop: localCrop };
        setCropDragging(true);
        return;
      }
      if (insideCrop(pt, localCrop)) {
        cropDragRef.current = { type: 'move', startPt: pt, startCrop: localCrop };
        setCropDragging(true);
        return;
      }
    }
    const seed: CropRect = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
    cropDragRef.current = { type: 'draw', startPt: pt, startCrop: seed };
    setLocalCrop(seed);
    setCropDragging(true);
  }

  function handleMouseUp() {
    if (!cropMode || !cropDragRef.current) return;
    cropDragRef.current = null;
    setCropDragging(false);
    setLocalCrop(prev => {
      if (!prev) return null;
      const norm = normalizeCrop(prev);
      if (norm.x2 - norm.x1 < 20 || norm.y2 - norm.y1 < 20) {
        onCropChange?.(null);
        return null;
      }
      onCropChange?.(norm);
      return norm;
    });
  }

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (cropMode) {
      if (!cropDragRef.current) return;
      const pt = getCanvasPoint(e);
      const { type, startPt, startCrop, corner } = cropDragRef.current;
      const W = resolution[0], H = resolution[1];
      if (type === 'draw') {
        setLocalCrop({ ...startCrop, x2: pt.x, y2: pt.y });
      } else if (type === 'move') {
        const dx = pt.x - startPt.x, dy = pt.y - startPt.y;
        const w = startCrop.x2 - startCrop.x1, h = startCrop.y2 - startCrop.y1;
        setLocalCrop({ x1: clamp(startCrop.x1 + dx, 0, W - w), y1: clamp(startCrop.y1 + dy, 0, H - h), x2: clamp(startCrop.x1 + dx, 0, W - w) + w, y2: clamp(startCrop.y1 + dy, 0, H - h) + h });
      } else if (type === 'resize' && corner) {
        const r = { ...startCrop };
        if (corner === 'tl') { r.x1 = clamp(pt.x, 0, r.x2 - 10); r.y1 = clamp(pt.y, 0, r.y2 - 10); }
        else if (corner === 'tr') { r.x2 = clamp(pt.x, r.x1 + 10, W); r.y1 = clamp(pt.y, 0, r.y2 - 10); }
        else if (corner === 'bl') { r.x1 = clamp(pt.x, 0, r.x2 - 10); r.y2 = clamp(pt.y, r.y1 + 10, H); }
        else if (corner === 'br') { r.x2 = clamp(pt.x, r.x1 + 10, W); r.y2 = clamp(pt.y, r.y1 + 10, H); }
        setLocalCrop(r);
      }
      return;
    }
    setMousePos(getCanvasPoint(e));
  }

  // ── Zone click handler (operates on the active layer only) ─────────────────

  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (cropMode) return;
    if (bgMode === 'capture' && !captureImgRef.current) return;
    if (!activeLayer) return;
    const pt = getCanvasPoint(e);

    if (pendingPoints.length >= 3 && dist(pt, pendingPoints[0]) <= SNAP_RADIUS) {
      const newZone: DrawnZone = {
        label: getZoneLetter(activeLayer.zones.length),
        points: [...pendingPoints],
      };
      const updated = [...activeLayer.zones, newZone];
      setPendingPoints([]);
      activeLayer.onChange(updated);
    } else {
      setPendingPoints(prev => [...prev, pt]);
    }
  }

  function undo() {
    if (pendingPoints.length > 0) {
      setPendingPoints(prev => prev.slice(0, -1));
      return;
    }
    if (activeLayer && activeLayer.zones.length > 0) {
      activeLayer.onChange(activeLayer.zones.slice(0, -1));
    }
  }

  function clearAll() {
    setPendingPoints([]);
    activeLayer?.onChange([]);
  }

  const canUndo = pendingPoints.length > 0 || (activeLayer?.zones.length ?? 0) > 0;
  const cursorStyle = cropMode ? (cropDragging ? 'grabbing' : 'crosshair') : 'crosshair';
  const totalZoneCount = layers.reduce((sum, l) => sum + l.zones.length, 0);

  return (
    <div className="space-y-3">
      {layers.length > 1 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground mr-1">Editing:</span>
          {layers.map(layer => (
            <button
              key={layer.key}
              type="button"
              onClick={() => { setActiveLayerKey(layer.key); setPendingPoints([]); }}
              className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                layer.key === activeLayerKey
                  ? 'text-white border-transparent'
                  : 'text-muted-foreground border-border hover:bg-accent'
              }`}
              style={layer.key === activeLayerKey ? { backgroundColor: layer.color } : undefined}
            >
              {layer.label} ({layer.zones.length})
            </button>
          ))}
        </div>
      )}

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

        {onCropChange && (
          <>
            <Button
              variant={cropMode ? 'default' : 'outline'}
              size="sm"
              onClick={() => { setCropMode(v => !v); setPendingPoints([]); }}
            >
              <Crop className="w-4 h-4 mr-2" />
              {cropMode ? 'Done' : 'Edit Crop'}
            </Button>
            {localCrop && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setLocalCrop(null); onCropChange(null); }}
              >
                <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                Crop
              </Button>
            )}
          </>
        )}

        <Button variant="outline" size="sm" onClick={undo} disabled={!canUndo}>
          <Undo2 className="w-4 h-4 mr-2" />
          Undo
        </Button>
        <Button variant="outline" size="sm" onClick={clearAll} disabled={(activeLayer?.zones.length ?? 0) === 0 && pendingPoints.length === 0}>
          <Trash2 className="w-4 h-4 mr-2" />
          Clear {layers.length > 1 ? activeLayer?.label : 'All'}
        </Button>
      </div>

      {captureError && bgMode === 'capture' && (
        <p className="text-xs text-destructive bg-destructive/10 rounded px-3 py-2">{captureError}</p>
      )}

      {streamFailed && bgMode === 'stream' && (
        <p className="text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/30 rounded px-3 py-2">
          Stream unavailable.{' '}
          <button className="underline font-medium" type="button" onClick={() => switchMode('capture')}>Switch to Capture mode</button>
          {' '}to use a static frame instead.
        </p>
      )}

      {cropMode && (
        <p className="text-xs text-primary/80 bg-primary/10 rounded px-3 py-2">
          Drag to draw crop area · drag inside to move · corner handles to resize · click <strong>Done</strong> to go back to zone drawing
        </p>
      )}

      <div
        className="relative border border-border rounded-lg overflow-hidden bg-gray-900"
        style={{ aspectRatio: `${resolution[0]}/${resolution[1]}` }}
      >
        {bgMode === 'stream' && !streamFailed && (
          <img
            ref={streamImgRef}
            src={`/api/stream/${deviceCode}`}
            className="absolute inset-0 w-full h-full object-contain pointer-events-none"
            onLoad={() => setStreamConnecting(false)}
            onError={() => { setStreamFailed(true); setStreamConnecting(false); }}
            alt=""
          />
        )}
        <canvas
          ref={canvasRef}
          width={resolution[0]}
          height={resolution[1]}
          className="absolute inset-0 w-full h-full"
          style={{ background: bgMode === 'stream' ? 'transparent' : undefined, cursor: cursorStyle }}
          onClick={handleCanvasClick}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => { setMousePos(null); handleMouseUp(); }}
        />
        {bgMode === 'stream' && streamConnecting && !streamFailed && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 pointer-events-none">
            <Loader2 className="w-6 h-6 text-white/50 animate-spin" />
          </div>
        )}
      </div>

      <div className="text-xs text-muted-foreground space-y-0.5">
        <p>Click to place polygon vertices. Click near the first point (red circle) to close the zone.</p>
        <p>
          {layers.length > 1
            ? `Drawing into "${activeLayer?.label}" — switch tabs above to edit a different zone type.`
            : 'Multiple zones can be drawn — each zone fires an event when a person enters.'}
        </p>
      </div>

      {totalZoneCount > 0 && (
        <div className="bg-muted/40 rounded p-3 space-y-2">
          {layers.filter(l => l.zones.length > 0).map(layer => (
            <div key={layer.key} className="space-y-1">
              {layers.length > 1 && (
                <p className="text-xs font-medium uppercase tracking-wide" style={{ color: layer.color }}>
                  {layer.label}
                </p>
              )}
              {layer.zones.map((zone, i) => (
                <div key={i} className="flex items-center gap-2 text-xs font-mono">
                  <span className="text-muted-foreground w-16">zone{zone.label}:</span>
                  <span>{zone.points.length} vertices</span>
                  <span className="text-muted-foreground">
                    [{zone.points.map(p => `(${p.x},${p.y})`).join(', ')}]
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {localCrop && (
        <div className="bg-muted/40 rounded p-3 text-xs font-mono">
          <span className="text-muted-foreground">CROP_AREA = </span>
          <span>[({localCrop.x1}, {localCrop.y1}), ({localCrop.x2}, {localCrop.y2})]</span>
          <span className="text-muted-foreground ml-3">— {localCrop.x2 - localCrop.x1} × {localCrop.y2 - localCrop.y1} px</span>
        </div>
      )}
    </div>
  );
}
