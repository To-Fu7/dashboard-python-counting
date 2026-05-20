'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Trash2, ImageIcon, Loader2 } from 'lucide-react';

import type { CropRect } from '@/lib/types';
export type { CropRect } from '@/lib/types';

interface Point { x: number; y: number }

interface CropDrawerProps {
  deviceCode: string;
  resolution?: [number, number];
  initialCrop?: CropRect | null;
  onChange: (crop: CropRect | null) => void;
}

const HANDLE_SIZE = 8;

function normalize(r: { x1: number; y1: number; x2: number; y2: number }): CropRect {
  return {
    x1: Math.round(Math.min(r.x1, r.x2)),
    y1: Math.round(Math.min(r.y1, r.y2)),
    x2: Math.round(Math.max(r.x1, r.x2)),
    y2: Math.round(Math.max(r.y1, r.y2)),
  };
}

function clamp(v: number, min: number, max: number) { return Math.max(min, Math.min(max, v)); }

export function CropDrawer({
  deviceCode,
  resolution = [800, 600],
  initialCrop = null,
  onChange,
}: CropDrawerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const captureImgRef = useRef<HTMLImageElement | null>(null);
  const streamImgRef = useRef<HTMLImageElement | null>(null);

  const [bgMode, setBgMode] = useState<'stream' | 'capture'>('stream');
  const [streamFailed, setStreamFailed] = useState(false);
  const [streamConnecting, setStreamConnecting] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);

  const [crop, setCrop] = useState<CropRect | null>(initialCrop ?? null);

  // Drag state
  const dragRef = useRef<{
    type: 'draw' | 'move' | 'resize';
    corner?: 'tl' | 'tr' | 'bl' | 'br';
    startPt: Point;
    startCrop: CropRect | null;
  } | null>(null);

  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    setCrop(initialCrop ?? null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

    // Draw static frame background in capture mode
    if (bgMode === 'capture') {
      if (captureImgRef.current) {
        ctx.drawImage(captureImgRef.current, 0, 0, W, H);
      } else {
        ctx.fillStyle = '#1f2937';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#6b7280';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Capture a frame to draw the crop area', W / 2, H / 2);
      }
    }

    if (crop) {
      const { x1, y1, x2, y2 } = crop;

      // Darken outside crop
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, 0, W, y1);                   // top
      ctx.fillRect(0, y2, W, H - y2);              // bottom
      ctx.fillRect(0, y1, x1, y2 - y1);            // left
      ctx.fillRect(x2, y1, W - x2, y2 - y1);       // right
      ctx.restore();

      // Crop border — dashed white
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.restore();

      // Corner handles
      const corners: [number, number][] = [[x1, y1], [x2, y1], [x1, y2], [x2, y2]];
      for (const [cx, cy] of corners) {
        ctx.save();
        ctx.fillStyle = '#3b82f6';
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        ctx.fillRect(cx - HANDLE_SIZE / 2, cy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
        ctx.strokeRect(cx - HANDLE_SIZE / 2, cy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
        ctx.restore();
      }

      // Label
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(x1 + 4, y1 + 4, 86, 18);
      ctx.fillStyle = '#00ffff';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('Detection Area', x1 + 8, y1 + 16);
      ctx.restore();

      // Dimensions hint
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x1 + 4, y2 - 20, 90, 16);
      ctx.fillStyle = '#d1d5db';
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`${x2 - x1} × ${y2 - y1}`, x1 + 8, y2 - 8);
      ctx.restore();
    } else if (bgMode !== 'stream') {
      // Hint when nothing drawn yet
      ctx.save();
      ctx.fillStyle = '#6b7280';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Click and drag to define the detection area', W / 2, H / 2 + (bgMode === 'capture' && captureImgRef.current ? 24 : 0));
      ctx.restore();
    }
  }, [crop, bgMode]);

  useEffect(() => { drawCanvas(); }, [drawCanvas]);

  function getCanvasPoint(e: React.MouseEvent<HTMLCanvasElement>): Point {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: clamp(Math.round((e.clientX - rect.left) * (canvas.width / rect.width)), 0, canvas.width),
      y: clamp(Math.round((e.clientY - rect.top) * (canvas.height / rect.height)), 0, canvas.height),
    };
  }

  function getCornerAt(pt: Point, r: CropRect): 'tl' | 'tr' | 'bl' | 'br' | null {
    const hit = HANDLE_SIZE;
    if (Math.abs(pt.x - r.x1) <= hit && Math.abs(pt.y - r.y1) <= hit) return 'tl';
    if (Math.abs(pt.x - r.x2) <= hit && Math.abs(pt.y - r.y1) <= hit) return 'tr';
    if (Math.abs(pt.x - r.x1) <= hit && Math.abs(pt.y - r.y2) <= hit) return 'bl';
    if (Math.abs(pt.x - r.x2) <= hit && Math.abs(pt.y - r.y2) <= hit) return 'br';
    return null;
  }

  function insideRect(pt: Point, r: CropRect): boolean {
    return pt.x >= r.x1 && pt.x <= r.x2 && pt.y >= r.y1 && pt.y <= r.y2;
  }

  function handleMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    const pt = getCanvasPoint(e);
    if (crop) {
      const corner = getCornerAt(pt, crop);
      if (corner) {
        dragRef.current = { type: 'resize', corner, startPt: pt, startCrop: crop };
        setDragging(true);
        return;
      }
      if (insideRect(pt, crop)) {
        dragRef.current = { type: 'move', startPt: pt, startCrop: crop };
        setDragging(true);
        return;
      }
    }
    // Start new draw
    dragRef.current = { type: 'draw', startPt: pt, startCrop: null };
    setCrop({ x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y });
    setDragging(true);
  }

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!dragRef.current) return;
    const pt = getCanvasPoint(e);
    const { type, startPt, startCrop, corner } = dragRef.current;
    const W = resolution[0];
    const H = resolution[1];

    if (type === 'draw') {
      setCrop({ x1: startPt.x, y1: startPt.y, x2: pt.x, y2: pt.y });
    } else if (type === 'move' && startCrop) {
      const dx = pt.x - startPt.x;
      const dy = pt.y - startPt.y;
      const w = startCrop.x2 - startCrop.x1;
      const h = startCrop.y2 - startCrop.y1;
      const nx1 = clamp(startCrop.x1 + dx, 0, W - w);
      const ny1 = clamp(startCrop.y1 + dy, 0, H - h);
      setCrop({ x1: nx1, y1: ny1, x2: nx1 + w, y2: ny1 + h });
    } else if (type === 'resize' && startCrop && corner) {
      const r = { ...startCrop };
      if (corner === 'tl') { r.x1 = clamp(pt.x, 0, r.x2 - 10); r.y1 = clamp(pt.y, 0, r.y2 - 10); }
      else if (corner === 'tr') { r.x2 = clamp(pt.x, r.x1 + 10, W); r.y1 = clamp(pt.y, 0, r.y2 - 10); }
      else if (corner === 'bl') { r.x1 = clamp(pt.x, 0, r.x2 - 10); r.y2 = clamp(pt.y, r.y1 + 10, H); }
      else if (corner === 'br') { r.x2 = clamp(pt.x, r.x1 + 10, W); r.y2 = clamp(pt.y, r.y1 + 10, H); }
      setCrop(r);
    }
  }

  function handleMouseUp() {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    setCrop(prev => {
      if (!prev) return null;
      const normalized = normalize(prev);
      // Discard tiny accidental drags (< 20px in either dimension)
      if (normalized.x2 - normalized.x1 < 20 || normalized.y2 - normalized.y1 < 20) {
        onChange(null);
        return null;
      }
      onChange(normalized);
      return normalized;
    });
  }

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

  function clearCrop() {
    setCrop(null);
    onChange(null);
  }

  const cursorStyle = dragging ? 'grabbing'
    : crop ? 'grab'
    : 'crosshair';

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
        <Button variant="outline" size="sm" onClick={clearCrop} disabled={!crop}>
          <Trash2 className="w-4 h-4 mr-2" />
          Clear
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
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        />
        {bgMode === 'stream' && streamConnecting && !streamFailed && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 pointer-events-none">
            <Loader2 className="w-6 h-6 text-white/50 animate-spin" />
          </div>
        )}
      </div>

      <div className="text-xs text-muted-foreground space-y-0.5">
        <p><span className="font-medium">Drag</span> on the frame to define the detection area. YOLO only processes pixels inside this rectangle.</p>
        <p>Detection lines and zones outside this area won&apos;t trigger events (no objects detected there). Leave empty for full frame.</p>
      </div>

      {crop && (
        <div className="bg-muted/40 rounded p-3 text-xs font-mono">
          <span className="text-muted-foreground">CROP_AREA = </span>
          <span>[({crop.x1}, {crop.y1}), ({crop.x2}, {crop.y2})]</span>
          <span className="text-muted-foreground ml-3">— {crop.x2 - crop.x1} × {crop.y2 - crop.y1} px</span>
        </div>
      )}
    </div>
  );
}
