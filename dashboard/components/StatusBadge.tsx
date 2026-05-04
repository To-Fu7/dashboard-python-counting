import { Badge } from '@/components/ui/badge';
import type { ContainerStatus } from '@/lib/types';

const STATUS_MAP: Record<ContainerStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  running: { label: 'Running', variant: 'default' },
  stopped: { label: 'Stopped', variant: 'secondary' },
  error: { label: 'Error', variant: 'destructive' },
  unknown: { label: 'Unknown', variant: 'outline' },
  not_found: { label: 'Not Found', variant: 'outline' },
};

export function StatusBadge({ status }: { status: ContainerStatus }) {
  const { label, variant } = STATUS_MAP[status] ?? STATUS_MAP.unknown;
  return (
    <Badge variant={variant} className={status === 'running' ? 'bg-emerald-500 hover:bg-emerald-500 text-white' : undefined}>
      {status === 'running' && <span className="mr-1.5 inline-block w-1.5 h-1.5 rounded-full bg-white animate-pulse" />}
      {label}
    </Badge>
  );
}
