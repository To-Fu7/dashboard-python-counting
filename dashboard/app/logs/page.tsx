'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

interface LogEntry {
  containerCode: string;
  containerName: string;
  line: string;
}

interface Device {
  deviceCode: string;
  deviceName: string;
}

function getLogLevel(line: string): 'error' | 'warning' | 'info' {
  if (/error|exception|fatal|critical/i.test(line)) return 'error';
  if (/warning|warn/i.test(line)) return 'warning';
  return 'info';
}

export default function LogsPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedCode, setSelectedCode] = useState('all');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [liveStreaming, setLiveStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/devices')
      .then(r => r.json())
      .then(d => setDevices(d.devices || []))
      .catch(() => {});
  }, []);

  const fetchLogs = useCallback(async () => {
    setRefreshing(true);
    try {
      const params = new URLSearchParams({ tail: '300' });
      if (selectedCode !== 'all') params.set('container', selectedCode);
      const res = await fetch(`/api/logs?${params}`);
      const data = await res.json();
      setLogs(data.logs || []);
      setTimeout(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      }, 50);
    } catch {
      toast.error('Failed to fetch logs');
    } finally {
      setRefreshing(false);
    }
  }, [selectedCode]);

  // "All cameras" mode: initial load + optional polling
  useEffect(() => {
    if (selectedCode !== 'all') return;
    fetchLogs();
  }, [selectedCode, fetchLogs]);

  useEffect(() => {
    if (selectedCode !== 'all' || !autoRefresh) return;
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, [selectedCode, autoRefresh, fetchLogs]);

  // Specific device mode: SSE streaming
  useEffect(() => {
    if (selectedCode === 'all') return;

    setLogs([]);
    setLiveStreaming(false);

    const es = new EventSource(`/api/devices/${selectedCode}/logs/stream?tail=200`);
    setLiveStreaming(true);

    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (typeof parsed === 'object' && parsed !== null) {
          if (parsed.__eof) { setLiveStreaming(false); es.close(); }
          return;
        }
        const line = String(parsed);
        setLogs(prev => {
          const next = [...prev, { containerCode: selectedCode, containerName: selectedCode, line }];
          return next.length > 1000 ? next.slice(-1000) : next;
        });
        setTimeout(() => {
          if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          }
        }, 10);
      } catch { /* ignore */ }
    };

    es.onerror = () => { setLiveStreaming(false); es.close(); };

    return () => { es.close(); setLiveStreaming(false); };
  }, [selectedCode]);

  const displayed = logs.filter(l =>
    !filter || l.line.toLowerCase().includes(filter.toLowerCase()) || l.containerCode.toLowerCase().includes(filter.toLowerCase())
  );

  const errorCount = displayed.filter(l => getLogLevel(l.line) === 'error').length;
  const warnCount = displayed.filter(l => getLogLevel(l.line) === 'warning').length;

  return (
    <div className="p-6 space-y-4 h-full flex flex-col">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Logs</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {displayed.length} lines
            {errorCount > 0 && <> · <span className="text-red-500">{errorCount} errors</span></>}
            {warnCount > 0 && <> · <span className="text-yellow-500">{warnCount} warnings</span></>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {selectedCode === 'all' ? (
            <>
              <Button
                variant={autoRefresh ? 'default' : 'outline'}
                size="sm"
                onClick={() => setAutoRefresh(v => !v)}
              >
                {autoRefresh ? 'Auto-refresh ON' : 'Auto-refresh OFF'}
              </Button>
              <Button variant="outline" size="sm" onClick={fetchLogs} disabled={refreshing}>
                <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
              </Button>
            </>
          ) : (
            <div className="flex items-center gap-3">
              {liveStreaming ? (
                <span className="flex items-center gap-1.5 text-xs text-green-400">
                  <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse inline-block" />
                  Live
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">Disconnected</span>
              )}
              <Button variant="ghost" size="sm" onClick={() => setLogs([])}>Clear</Button>
            </div>
          )}
        </div>
      </div>

      <div className="flex gap-2">
        <Select value={selectedCode} onValueChange={v => v && setSelectedCode(v)}>
          <SelectTrigger className="w-56">
            <SelectValue placeholder="All cameras" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All cameras</SelectItem>
            {devices.map(d => (
              <SelectItem key={d.deviceCode} value={d.deviceCode}>
                {d.deviceName} ({d.deviceCode})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          placeholder="Filter logs..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="max-w-72"
        />
      </div>

      <div className="flex-1 min-h-0">
        <div
          ref={scrollRef}
          className="h-full rounded border border-border bg-black/90 p-3 overflow-y-auto"
        >
          {displayed.length === 0 ? (
            <p className="text-xs text-gray-500 py-4 text-center">
              {selectedCode !== 'all' && liveStreaming ? 'Waiting for logs...' : 'No logs found.'}
            </p>
          ) : (
            displayed.map((entry, i) => {
              const level = getLogLevel(entry.line);
              return (
                <div key={i} className="flex gap-2 items-start">
                  {selectedCode === 'all' && (
                    <span className="text-xs font-mono text-gray-500 shrink-0 pt-0.5 w-28 truncate">
                      [{entry.containerCode}]
                    </span>
                  )}
                  <p className={`text-xs font-mono leading-5 flex-1 ${
                    level === 'error' ? 'text-red-400' :
                    level === 'warning' ? 'text-yellow-400' :
                    'text-gray-300'
                  }`}>
                    {entry.line}
                  </p>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
