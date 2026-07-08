'use client';

import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/** Triton model picker with ready-state badge and free-text fallback when the
 *  repository index is unavailable — shared by the device detail page (primary,
 *  APD, Fire/Smoke, Face models) and the Settings page (ArcFace embed model)
 *  so the readiness display can't drift between them. */
export function ModelSelect({ value, onChange, placeholder, models }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  models: { name: string; state: string }[];
}) {
  if (models.length === 0) {
    return <Input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />;
  }
  return (
    <Select value={value} onValueChange={v => v && onChange(v)}>
      <SelectTrigger><SelectValue placeholder="Select a model" /></SelectTrigger>
      <SelectContent>
        {models.map(m => (
          <SelectItem key={m.name} value={m.name}>
            {m.name} {m.state === 'READY' ? '● ready' : m.state === 'OFFLINE' ? '○ triton offline' : `(${m.state.toLowerCase()})`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
