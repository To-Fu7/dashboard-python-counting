'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Undo2, Trash2, ImageIcon, Loader2, Crop } from 'lucide-react';
import type { CropRect } from '@/lib/types';

interface Point { x: number; y: number }
interface DrawnLine { label: string; p1: Point; p2: Point }

interface LineDrawerProps {
  deviceCode: string;
  containerStatus: string;
  resolution?: [number, number];
  initialLines?: DrawnLine[];
  offsetAxis?: string;
  offsetAmount?: number;
  onChange: (lines: DrawnLine[]) => void;
  cropRect?: CropRect | null;
  onCropChange?: (crop: CropRect | null) => void;
}

function getLetter(index: number): string {
  return String.fromCharCode(65 + index * 2);
}

function computeOffsetLine(p1: Point, p2: Point, axis: string, amount: number): [Point, Point] {
  if (axis === 'X') return [{ x: p1.x + amount, y: p1.y }, { x: p2.x + amount, y: p2.y }];
  return [{ x: p1.x, y: p1.y + amount }, { x: p2.x, y: p2.y + amount }];
}

const LINE_COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899'];
const CROP_HANDLE = 8;

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

export function LineDrawer({
  deviceCode,
  resolution = [800, 600],
  initialLines = [],
  offsetAxis = 'Y',
  offsetAmount = 5,
  onChange,
  cropRect = null,
  onCropChange,
}: LineDrawerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const captureImgRef = useRef<HTMLImageElement | null>(null);
  const streamImgRef = useRef<HTMLImageElement | null>(null);

  const [bgMode, setBgMode] = useState<'stream' | 'capture'>('stream');
  const [streamFailed, setStreamFailed] = useState(false);
  const [streamConnecting, setStreamConnecting] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [lines, setLines] = useState<DrawnLine[]>(initialLines);
  const [pendingPoint, setPendingPoint] = useState<Point | null>(null);
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

  useEffect(() => {
    setLines(initialLines);
  }, [initialLines.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setLocalCrop(cropRect ?? null);
  }, [cropRect]);

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
        ctx.fillText('Capture a frame to start drawing lines', W / 2, H / 2);
      }
    }

    // Crop area overlay — rendered before lines so lines appear on top
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

    // Lines overlay
    lines.forEach((line, i) => {
      const color = LINE_COLORS[i % LINE_COLORS.length];
      const [offP1, offP2] = computeOffsetLine(line.p1, line.p2, offsetAxis, offsetAmount);

      ctx.save();
      ctx.strokeStyle = '#fcd34d';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(offP1.x, offP1.y);
      ctx.lineTo(offP2.x, offP2.y);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(line.p1.x, line.p1.y);
      ctx.lineTo(line.p2.x, line.p2.y);
      ctx.stroke();
      const mx = (line.p1.x + line.p2.x) / 2;
      const my = (line.p1.y + line.p2.y) / 2;
      ctx.fillStyle = color;
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`Gate ${i + 1} (line${line.label})`, mx, my - 8);
      ctx.restore();

      for (const p of [line.p1, line.p2]) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
    });

    // Pending point preview
    if (pendingPoint) {
      ctx.beginPath();
      ctx.arc(pendingPoint.x, pendingPoint.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#ef4444';
      ctx.fill();
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (mousePos) {
        ctx.save();
        ctx.strokeStyle = 'rgba(239,68,68,0.6)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(pendingPoint.x, pendingPoint.y);
        ctx.lineTo(mousePos.x, mousePos.y);
        ctx.stroke();
        ctx.restore();
      }

      ctx.fillStyle = '#ef4444';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'left';
      ctx.setLineDash([]);
      ctx.fillText('Click second point...', pendingPoint.x + 10, pendingPoint.y - 8);
    }
  }, [lines, pendingPoint, mousePos, offsetAxis, offsetAmount, bgMode, localCrop, cropMode]);

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
    if (!pendingPoint) return;
    setMousePos(getCanvasPoint(e));
  }

  // ── Line click handler ──────────────────────────────────────────────────────

  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (cropMode) return;
    if (bgMode === 'capture' && !captureImgRef.current) return;
    const pt = getCanvasPoint(e);
    if (!pendingPoint) {
      setPendingPoint(pt);
    } else {
      const newLine: DrawnLine = { label: getLetter(lines.length), p1: pendingPoint, p2: pt };
      const updated = [...lines, newLine];
      setLines(updated);
      setPendingPoint(null);
      onChange(updated);
    }
  }

  function undo() {
    if (pendingPoint) { setPendingPoint(null); return; }
    if (lines.length > 0) {
      const updated = lines.slice(0, -1);
      setLines(updated);
      onChange(updated);
    }
  }

  function clearAll() {
    setLines([]);
    setPendingPoint(null);
    onChange([]);
  }

  const cursorStyle = cropMode ? (cropDragging ? 'grabbing' : 'crosshair') : 'crosshair';

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

        {onCropChange && (
          <>
            <Button
              variant={cropMode ? 'default' : 'outline'}
              size="sm"
              onClick={() => { setCropMode(v => !v); setPendingPoint(null); }}
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

        <Button variant="outline" size="sm" onClick={undo} disabled={lines.length === 0 && !pendingPoint}>
          <Undo2 className="w-4 h-4 mr-2" />
          Undo
        </Button>
        <Button variant="outline" size="sm" onClick={clearAll} disabled={lines.length === 0}>
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
          <button className="underline font-medium" type="button" onClick={() => switchMode('capture')}>
            Switch to Capture mode
          </button>
          {' '}to use a static frame instead.
        </p>
      )}

      {cropMode && (
        <p className="text-xs text-primary/80 bg-primary/10 rounded px-3 py-2">
          Drag to draw crop area · drag inside to move · corner handles to resize · click <strong>Done</strong> to go back to line drawing
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
        <p><span className="font-medium">Blue solid lines</span> = IN detection lines (lineA, lineC, lineE...)</p>
        <p><span className="font-medium">Yellow dashed lines</span> = Auto-generated OUT lines (preview only)</p>
        <p>Click two points on the {bgMode === 'stream' ? 'stream' : 'frame'} to draw a gate.</p>
      </div>

      {lines.length > 0 && (
        <div className="bg-muted/40 rounded p-3 space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Defined Gates</p>
          {lines.map((line, i) => (
            <div key={i} className="flex items-center gap-2 text-xs font-mono">
              <span className="text-muted-foreground w-16">line{line.label}:</span>
              <span>[({line.p1.x}, {line.p1.y}), ({line.p2.x}, {line.p2.y})]</span>
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
