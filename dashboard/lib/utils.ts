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
 * host that, by definition, it can route to. So take that hostname and point it
 * at the gateway's port, keeping the scheme (ws:// for MSE/WebRTC, http:// for
 * HLS) and path intact.
 *
 * This replaced a manual "Public Base URL" setting that had to be set per
 * deployment and only took effect after recreating the gateway container.
 * Client-only — reads window.
 */
export function toReachableStreamUrl(rawUrl: string): string {
  if (typeof window === 'undefined') return rawUrl;
  try {
    const url = new URL(rawUrl);
    url.hostname = window.location.hostname;
    url.port = String(STREAM_GATEWAY_PORT);
    return url.toString();
  } catch {
    return rawUrl; // not an absolute URL — hand back untouched rather than break playback
  }
}
