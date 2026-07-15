import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Port stream-gateway serves HLS/MSE/WebRTC on (dashboard/docker-compose.yml
// publishes it as 8555:8555).
const STREAM_GATEWAY_PORT = 8555;

/**
 * Rewrites a stream URL returned by stream-gateway so the browser can actually
 * open it.
 *
 * stream-gateway builds absolute URLs from its own PUBLIC_BASE_URL, which
 * defaults to localhost and can't know which address THIS browser reached the
 * dashboard on. But the browser already knows: it's loading this page from a
 * host that, by definition, it can route to. So by default take that hostname
 * and point it at the gateway's port.
 *
 * `overrideBaseUrl` (Settings -> Stream Gateway -> Public Base URL) wins when
 * set, for deployments where the gateway ISN'T at the dashboard's own host.
 * Only its host and port are used — the scheme always comes from the original
 * URL, so the ws:// MSE URL stays ws:// even though the override is written
 * http://. The path is always preserved.
 *
 * Applied per page load, so changing the override takes effect immediately
 * without recreating the gateway container.
 */
export function toReachableStreamUrl(rawUrl: string, overrideBaseUrl?: string): string {
  try {
    const url = new URL(rawUrl);
    if (overrideBaseUrl) {
      const base = new URL(overrideBaseUrl);
      url.hostname = base.hostname;
      url.port = base.port || String(STREAM_GATEWAY_PORT);
      return url.toString();
    }
    if (typeof window === 'undefined') return rawUrl;
    url.hostname = window.location.hostname;
    url.port = String(STREAM_GATEWAY_PORT);
    return url.toString();
  } catch {
    return rawUrl; // not an absolute URL — hand back untouched rather than break playback
  }
}
