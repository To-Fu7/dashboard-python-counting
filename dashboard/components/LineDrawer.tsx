'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Undo2, Trash2, ImageIcon, Loader2 } from 'lucide-react';

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
}

function getLetter(index: number): string {
  return String.fromCharCode(65 + index * 2);
}

function computeOffsetLine(p1: Point, p2: Point, axis: string, amount: number): [Point, Point] {
  if (axis === 'X') return [{ x: p1.x + amount, y: p1.y }, { x: p2.x + amount, y: p2.y }];
  return [{ x: p1.x, y: p1.y + amount }, { x: p2.x, y: p2.y + amount }];
}

const LINE_COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899'];

export function LineDrawer({
  deviceCode,
  resolution = [800, 600],
  initialLines = [],
  offsetAxis = 'Y',
  offsetAmount = 5,
  onChange,
}: LineDrawerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const captureImgRef = useRef<HTMLImageElement | null>(null); // static frame for capture mode
  const lastFrameRef = useRef<HTMLImageElement | null>(null);  // latest video frame for stream mode

  const [bgMode, setBgMode] = useState<'stream' | 'capture'>('stream');
  const [streamFailed, setStreamFailed] = useState(false);
  const [streamConnecting, setStreamConnecting] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [lines, setLines] = useState<DrawnLine[]>(initialLines);
  const [pendingPoint, setPendingPoint] = useState<Point | null>(null);
  const [mousePos, setMousePos] = useState<Point | null>(null);

  useEffect(() => {
    setLines(initialLines);
  }, [initialLines.length]); // eslint-disable-line react-hooks/exhaustive-deps

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
        ctx.fillText('Capture a frame to start drawing lines', canvas.width / 2, canvas.height / 2);
      }
    } else {
      if (lastFrameRef.current) {
        ctx.drawImage(lastFrameRef.current, 0, 0, canvas.width, canvas.height);
      } else {
        ctx.fillStyle = '#1f2937';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
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

    // Pending point
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
      ctx.fillText('Click second point...', pendingPoint.x + 10, pendingPoint.y - 8);
    }
  }, [lines, pendingPoint, mousePos, offsetAxis, offsetAmount, bgMode]);

  // Always keep a ref to the latest drawCanvas so EventSource closure can call it
  const drawCanvasRef = useRef(drawCanvas);
  useEffect(() => { drawCanvasRef.current = drawCanvas; }, [drawCanvas]);

  // Redraw when state changes (lines drawn, mouse moves, etc.)
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

  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
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

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!pendingPoint) return;
    setMousePos(getCanvasPoint(e));
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
    </div>
  );
}
