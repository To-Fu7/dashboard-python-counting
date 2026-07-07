'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/** info/alarm tag picker shared by the Settings page and the device detail page. */
export function TagSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Select value={value} onValueChange={v => v && onChange(v)}>
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="info">info</SelectItem>
        <SelectItem value="alarm">alarm</SelectItem>
      </SelectContent>
    </Select>
  );
}
