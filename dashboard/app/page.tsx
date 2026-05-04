'use client';

import { useEffect, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/StatusBadge';
import { Play, Square, RotateCcw, Camera, AlertCircle, RefreshCw, Layers, HammerIcon } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import type { ContainerStatus } from '@/lib/types';

interface Device {
  deviceCode: string;
  deviceName: string;
  deviceId: string;
  containerName: string;
  rtspUrl: string;
  status: ContainerStatus;
}

export default function HomePage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<Record<string, string>>({});
  const [fullRestarting, setFullRestarting] = useState(false);
  const [imageReady, setImageReady] = useState<boolean | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildLog, setBuildLog] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/compose/status').then(r => r.json()).then(d => setImageReady(d.imageReady)).catch(() => setImageReady(false));
  }, []);

  async function buildImage() {
    setBuilding(true);
    setBuildLog(null);
    const toastId = toast.loading('Building Docker image... (this may take several minutes)');
    try {
      const res = await fetch('/api/compose/build', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setBuildLog(data.stderr || data.stdout || 'Build complete');
      setImageReady(true);
      toast.success('Image built successfully!', { id: toastId });
    } catch (e) {
      toast.error(`Build failed: ${e}`, { id: toastId });
      setBuildLog(String(e));
    } finally {
      setBuilding(false);
    }
  }

  async function fullRestart() {
    setFullRestarting(true);
    try {
      const res = await fetch('/api/compose/up', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success('docker compose up -d completed');
      setTimeout(fetchDevices, 2000);
    } catch (e) {
      toast.error(`Full restart failed: ${e}`);
    } finally {
      setFullRestarting(false);
    }
  }

  const fetchDevices = useCallback(async () => {
    try {
      const res = await fetch('/api/devices');
      const data = await res.json();
      setDevices(data.devices || []);
    } catch {
      toast.error('Failed to fetch devices');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDevices();
    const interval = setInterval(fetchDevices, 10000);
    return () => clearInterval(interval);
  }, [fetchDevices]);

  async function containerAction(code: string, action: 'start' | 'stop' | 'restart') {
    setActionLoading(prev => ({ ...prev, [code]: action }));
    try {
      const res = await fetch(`/api/devices/${code}/${action}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(`${action.charAt(0).toUpperCase() + action.slice(1)}ed ${code}`);
      setTimeout(fetchDevices, 1500);
    } catch (e) {
      toast.error(`Failed to ${action}: ${e}`);
    } finally {
      setActionLoading(prev => { const n = { ...prev }; delete n[code]; return n; });
    }
  }

  const running = devices.filter(d => d.status === 'running').length;
  const total = devices.length;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {loading ? 'Loading...' : `${running} of ${total} cameras running`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchDevices} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={fullRestart} disabled={fullRestarting}>
            <Layers className={`w-4 h-4 mr-2 ${fullRestarting ? 'animate-pulse' : ''}`} />
            {fullRestarting ? 'Running...' : 'Full Restart'}
          </Button>
        </div>
      </div>

      {imageReady === false && (
        <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-yellow-500 shrink-0 mt-0.5" />
          <div className="flex-1 space-y-2">
            <p className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
              Docker image not built yet
            </p>
            <p className="text-xs text-muted-foreground">
              The image <code className="font-mono bg-muted px-1 rounded">python-counting-services-python-1:latest</code> does not exist locally.
              Build it once before starting any cameras.
            </p>
            {buildLog && (
              <pre className="text-xs font-mono bg-black/80 text-gray-300 rounded p-2 max-h-32 overflow-auto whitespace-pre-wrap">
                {buildLog}
              </pre>
            )}
          </div>
          <Button size="sm" onClick={buildImage} disabled={building} className="shrink-0">
            <HammerIcon className={`w-4 h-4 mr-2 ${building ? 'animate-pulse' : ''}`} />
            {building ? 'Building...' : 'Build Image'}
          </Button>
        </div>
      )}

      {!loading && devices.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <Camera className="w-12 h-12 text-muted-foreground mb-4" />
          <p className="text-muted-foreground text-sm mb-4">No cameras configured yet.</p>
          <Link href="/devices">
            <Button size="sm">Add your first camera</Button>
          </Link>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {devices.map(device => (
          <DeviceCard
            key={device.deviceCode}
            device={device}
            actionLoading={actionLoading[device.deviceCode]}
            onAction={containerAction}
          />
        ))}
      </div>
    </div>
  );
}

function DeviceCard({
  device,
  actionLoading,
  onAction,
}: {
  device: Device;
  actionLoading?: string;
  onAction: (code: string, action: 'start' | 'stop' | 'restart') => void;
}) {
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    if (device.status !== 'running') return;
    fetch(`/api/devices/${device.deviceCode}/logs?tail=3`)
      .then(r => r.json())
      .then(d => setLogs(d.logs || []))
      .catch(() => {});
  }, [device.deviceCode, device.status]);

  const isLoading = !!actionLoading;

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-medium truncate">{device.deviceName}</p>
            <p className="text-xs text-muted-foreground font-mono">{device.deviceCode}</p>
          </div>
          <StatusBadge status={device.status} />
        </div>
      </CardHeader>

      <CardContent className="flex-1 space-y-3">
        {device.rtspUrl && (
          <p className="text-xs text-muted-foreground truncate" title={device.rtspUrl}>
            {device.rtspUrl.replace(/:[^@]+@/, ':***@')}
          </p>
        )}

        {device.status === 'running' && logs.length > 0 && (
          <div className="bg-muted rounded p-2 space-y-0.5 max-h-16 overflow-hidden">
            {logs.slice(-2).map((line, i) => (
              <p key={i} className="text-xs font-mono text-muted-foreground truncate">
                {line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.Z]+ /, '')}
              </p>
            ))}
          </div>
        )}

        {device.status === 'error' && (
          <div className="flex items-center gap-1.5 text-destructive text-xs">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            Container in error state
          </div>
        )}

        <div className="flex gap-1.5 pt-1">
          {device.status !== 'running' ? (
            <Button
              size="sm"
              className="flex-1"
              onClick={() => onAction(device.deviceCode, 'start')}
              disabled={isLoading}
            >
              <Play className="w-3.5 h-3.5 mr-1.5" />
              {actionLoading === 'start' ? 'Starting...' : 'Start'}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              onClick={() => onAction(device.deviceCode, 'stop')}
              disabled={isLoading}
            >
              <Square className="w-3.5 h-3.5 mr-1.5" />
              {actionLoading === 'stop' ? 'Stopping...' : 'Stop'}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => onAction(device.deviceCode, 'restart')}
            disabled={isLoading}
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </Button>
          <Link href={`/devices/${device.deviceCode}`}>
            <Button size="sm" variant="ghost">
              Edit
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
