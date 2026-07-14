'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LayoutDashboard, Camera, Settings, ScrollText, Activity, Tv2, UserSquare2 } from 'lucide-react';
// import { Workflow } from 'lucide-react'; // re-add alongside the Automation nav item below when re-enabling
import { cn } from '@/lib/utils';
import { EDGE_MODE } from '@/lib/edge-mode';

const ALL_NAV_ITEMS = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard, hideInEdgeMode: true },
  { href: '/devices', label: 'Devices', icon: Camera, hideInEdgeMode: false },
  { href: '/stream', label: 'Stream', icon: Tv2, hideInEdgeMode: false },
  { href: '/faces', label: 'Face Enrollment', icon: UserSquare2, hideInEdgeMode: true },
  // Node-RED integration temporarily disabled (server.js: NODERED_ENABLED) —
  // see nodered/DEV_NOTES.md (gitignored). Re-add once re-enabled:
  // { href: '/automation', label: 'Automation', icon: Workflow, hideInEdgeMode: false },
  { href: '/logs', label: 'Logs', icon: ScrollText, hideInEdgeMode: false },
  { href: '/settings', label: 'Settings', icon: Settings, hideInEdgeMode: false },
];

const NAV_ITEMS = ALL_NAV_ITEMS.filter(item => !(EDGE_MODE && item.hideInEdgeMode));

export function Sidebar() {
  const pathname = usePathname();
  const [appName, setAppName] = useState('EPiWalk');

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(d => { if (d.settings?.appName) setAppName(d.settings.appName); })
      .catch(() => {});
  }, []);

  return (
    <aside className="flex flex-col h-full w-60 border-r border-border bg-background">
      <div className="px-5 py-4 border-b border-border">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-primary" />
          <span className="font-semibold text-sm tracking-wide">{appName}</span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{EDGE_MODE ? 'Camera & Stream Forwarding' : 'Counting Dashboard'}</p>
      </div>

      <nav className="flex-1 px-3 py-3 space-y-0.5">
        {NAV_ITEMS.map(item => {
          const Icon = item.icon;
          const isActive = item.href === '/'
            ? pathname === '/'
            : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                isActive
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              )}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="px-5 py-3 border-t border-border">
        <p className="text-xs text-muted-foreground">v3-dashboard</p>
      </div>
    </aside>
  );
}
