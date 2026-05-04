'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { StatusBadge } from '@/components/StatusBadge';
import { Plus, Pencil, Trash2, RefreshCw, Play, Square, RotateCcw, Layers } from 'lucide-react';
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

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [actionLoading, setActionLoading] = useState<Record<string, string>>({});
  const [fullRestarting, setFullRestarting] = useState(false);

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

  async function deleteDevice(code: string) {
    if (!confirm(`Delete camera "${code}"? This will stop the container and remove its config files.`)) return;
    try {
      const res = await fetch(`/api/devices/${code}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(`Deleted ${code}`);
      fetchDevices();
    } catch (e) {
      toast.error(`Failed to delete: ${e}`);
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Devices</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {loading ? 'Loading...' : `${devices.length} camera${devices.length !== 1 ? 's' : ''} configured`}
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
          <Button size="sm" onClick={() => setShowAdd(true)}>
            <Plus className="w-4 h-4 mr-2" />
            Add Camera
          </Button>
        </div>
      </div>

      {!loading && devices.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground text-sm">
          No cameras configured. Click &quot;Add Camera&quot; to get started.
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 border-b border-border">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Code</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Stream URL</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {devices.map(device => {
                const isLoading = !!actionLoading[device.deviceCode];
                return (
                  <tr key={device.deviceCode} className="hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3 font-medium">{device.deviceName}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{device.deviceCode}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground max-w-56 truncate" title={device.rtspUrl}>
                      {device.rtspUrl ? device.rtspUrl.replace(/:[^@]+@/, ':***@') : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={device.status} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {device.status !== 'running' ? (
                          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => containerAction(device.deviceCode, 'start')} disabled={isLoading}>
                            <Play className="w-3.5 h-3.5" />
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => containerAction(device.deviceCode, 'stop')} disabled={isLoading}>
                            <Square className="w-3.5 h-3.5" />
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => containerAction(device.deviceCode, 'restart')} disabled={isLoading}>
                          <RotateCcw className="w-3.5 h-3.5" />
                        </Button>
                        <Link href={`/devices/${device.deviceCode}`}>
                          <Button size="sm" variant="ghost" className="h-7 px-2">
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                        </Link>
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-destructive hover:text-destructive" onClick={() => deleteDevice(device.deviceCode)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <AddCameraDialog
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onSuccess={() => { setShowAdd(false); fetchDevices(); }}
      />
    </div>
  );
}

function AddCameraDialog({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    deviceName: '',
    deviceCode: '',
    activityTopic: '/person_in',
    intervalTopic: '',
    rtspUrl: '',
  });

  function handleChange(field: string, value: string) {
    setForm(prev => ({ ...prev, [field]: value }));
    if (field === 'deviceName' && !form.deviceCode) {
      setForm(prev => ({ ...prev, deviceCode: value.toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '') }));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (/\s/.test(form.deviceCode)) {
      toast.error('Device Code must not contain spaces');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(`Camera "${form.deviceCode}" created`);
      setForm({ deviceName: '', deviceCode: '', activityTopic: '/person_in', intervalTopic: '', rtspUrl: '' });
      onSuccess();
    } catch (e) {
      toast.error(`Failed to create: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Camera</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Device Name" required>
            <Input
              value={form.deviceName}
              onChange={e => handleChange('deviceName', e.target.value)}
              placeholder="CCTV B2 Selatan"
              required
            />
          </Field>
          <Field label="Device Code" hint="No spaces — used as identifier" required>
            <Input
              value={form.deviceCode}
              onChange={e => handleChange('deviceCode', e.target.value.replace(/\s/g, '_').toUpperCase())}
              placeholder="CCTV_EPW_B2S"
              required
              pattern="^\S+$"
            />
          </Field>
          <Field label="Stream URL (RTSP)">
            <Input
              value={form.rtspUrl}
              onChange={e => handleChange('rtspUrl', e.target.value)}
              placeholder="rtsp://user:pass@192.168.1.1/stream"
            />
          </Field>
          <Field label="Activity Topic">
            <Input
              value={form.activityTopic}
              onChange={e => handleChange('activityTopic', e.target.value)}
              placeholder="/person_in"
            />
          </Field>
          <Field label="Interval Topic">
            <Input
              value={form.intervalTopic}
              onChange={e => handleChange('intervalTopic', e.target.value)}
              placeholder="/resampling_person/EPW/CCTV_EPW_B2S"
            />
          </Field>
          <div className="flex gap-2 pt-2 justify-end">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Creating...' : 'Create Camera'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, hint, required, children }: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </div>
  );
}
