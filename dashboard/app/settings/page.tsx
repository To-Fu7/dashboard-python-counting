'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import type { GlobalSettings } from '@/lib/types';
import { DEFAULT_SETTINGS } from '@/lib/types';

export default function SettingsPage() {
  const [settings, setSettings] = useState<GlobalSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(d => { if (d.settings) setSettings(d.settings); })
      .catch(() => toast.error('Failed to load settings'))
      .finally(() => setLoading(false));
  }, []);

  function setPg(key: keyof GlobalSettings['pg'], value: string) {
    setSettings(prev => ({ ...prev, pg: { ...prev.pg, [key]: value } }));
  }
  function setMqtt(key: keyof GlobalSettings['mqtt'], value: string) {
    setSettings(prev => ({ ...prev, mqtt: { ...prev.mqtt, [key]: value } }));
  }
  function setDefault(key: keyof GlobalSettings['defaults'], value: string) {
    setSettings(prev => ({ ...prev, defaults: { ...prev.defaults, [key]: value } }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success('Settings saved. New cameras will use these defaults.');
    } catch (e) {
      toast.error(`Failed to save: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="p-6 text-muted-foreground">Loading...</div>;

  return (
    <div className="p-6 space-y-8 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Global defaults applied when creating new cameras. Existing cameras are not affected.
        </p>
      </div>

      <Section title="Dashboard">
        <FormField label="Dashboard Name">
          <Input
            value={settings.appName}
            onChange={e => setSettings(prev => ({ ...prev, appName: e.target.value }))}
            placeholder="EPiWalk"
          />
        </FormField>
        <FormField label="Hardware Mode">
          <div className="flex gap-3 pt-1">
            {(['jetson', 'server', 'cpu'] as const).map(mode => (
              <button
                key={mode}
                type="button"
                onClick={() => setSettings(prev => ({ ...prev, hardwareMode: mode }))}
                className={`px-4 py-2 rounded-md text-sm border transition-colors ${
                  settings.hardwareMode === mode
                    ? 'border-primary bg-primary/10 text-primary font-medium'
                    : 'border-border text-muted-foreground hover:text-foreground hover:bg-accent'
                }`}
              >
                {mode === 'jetson' ? 'Jetson / Tegra' : mode === 'server' ? 'Mini Server (runtime: nvidia)' : 'CPU Only'}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-1.5">
            Changing this updates the Docker Compose template for all existing and new cameras.
          </p>
        </FormField>
      </Section>

      <Section title="PostgreSQL Database">
        <div className="grid grid-cols-2 gap-4">
          <FormField label="Host">
            <Input value={settings.pg.host} onChange={e => setPg('host', e.target.value)} placeholder="host.docker.internal" />
          </FormField>
          <FormField label="Port">
            <Input type="number" value={settings.pg.port} onChange={e => setPg('port', e.target.value)} placeholder="5432" />
          </FormField>
          <FormField label="Database">
            <Input value={settings.pg.db} onChange={e => setPg('db', e.target.value)} placeholder="postgres" />
          </FormField>
          <FormField label="User">
            <Input value={settings.pg.user} onChange={e => setPg('user', e.target.value)} placeholder="postgres" />
          </FormField>
          <FormField label="Password" className="col-span-2">
            <Input type="password" value={settings.pg.pass} onChange={e => setPg('pass', e.target.value)} />
          </FormField>
        </div>
      </Section>

      <Section title="MQTT Broker">
        <div className="grid grid-cols-2 gap-4">
          <FormField label="Broker Host">
            <Input value={settings.mqtt.broker} onChange={e => setMqtt('broker', e.target.value)} placeholder="10.11.0.34" />
          </FormField>
          <FormField label="Port">
            <Input type="number" value={settings.mqtt.port} onChange={e => setMqtt('port', e.target.value)} placeholder="1883" />
          </FormField>
          <FormField label="Username">
            <Input value={settings.mqtt.username} onChange={e => setMqtt('username', e.target.value)} />
          </FormField>
          <FormField label="Password">
            <Input type="password" value={settings.mqtt.password} onChange={e => setMqtt('password', e.target.value)} />
          </FormField>
        </div>
      </Section>

      <Section title="Detection Defaults">
        <div className="grid grid-cols-2 gap-4">
          <FormField label="YOLO Model">
            <Input value={settings.defaults.yolo_model} onChange={e => setDefault('yolo_model', e.target.value)} placeholder="yolo11n.pt" />
          </FormField>
          <FormField label="YOLO Confidence">
            <Input type="number" step="0.05" min="0" max="1" value={settings.defaults.yolo_confidence} onChange={e => setDefault('yolo_confidence', e.target.value)} />
          </FormField>
          <FormField label="JPEG Quality (1–100)">
            <Input type="number" min="1" max="100" value={settings.defaults.jpeg_quality} onChange={e => setDefault('jpeg_quality', e.target.value)} />
          </FormField>
          <FormField label="FPS Limit (0 = unlimited)">
            <Input type="number" value={settings.defaults.fps_limit} onChange={e => setDefault('fps_limit', e.target.value)} />
          </FormField>
          <FormField label="Frame Skip">
            <Input type="number" value={settings.defaults.frame_skip} onChange={e => setDefault('frame_skip', e.target.value)} />
          </FormField>
          <FormField label="Detection Margin (px)">
            <Input type="number" value={settings.defaults.detection_margin} onChange={e => setDefault('detection_margin', e.target.value)} />
          </FormField>
          <FormField label="MQTT Interval (minutes)">
            <Input type="number" value={settings.defaults.mqtt_interval_minutes} onChange={e => setDefault('mqtt_interval_minutes', e.target.value)} />
          </FormField>
          <FormField label="Daily Send Time">
            <Input value={settings.defaults.daily_send_time} onChange={e => setDefault('daily_send_time', e.target.value)} placeholder="23:59" />
          </FormField>
          <FormField label="NVDEC (GPU Hardware Decoding)">
            <div className="flex items-center gap-2 pt-2">
              <Switch
                checked={settings.defaults.enable_nvdec === 'true'}
                onCheckedChange={v => setDefault('enable_nvdec', v ? 'true' : 'false')}
              />
              <span className="text-sm text-muted-foreground">
                {settings.defaults.enable_nvdec === 'true' ? 'Enabled' : 'Disabled'}
              </span>
            </div>
          </FormField>
          <FormField label="Debug Mode">
            <div className="flex items-center gap-2 pt-2">
              <Switch
                checked={settings.defaults.debug_mode === 'true'}
                onCheckedChange={v => setDefault('debug_mode', v ? 'true' : 'false')}
              />
              <span className="text-sm text-muted-foreground">
                {settings.defaults.debug_mode === 'true' ? 'ON (display enabled, no MQTT/DB)' : 'OFF (production mode)'}
              </span>
            </div>
          </FormField>
        </div>
      </Section>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save Settings'}
        </Button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <div className="border-b border-border pb-2">
        <h2 className="font-medium text-sm">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function FormField({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`space-y-1.5 ${className || ''}`}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}
