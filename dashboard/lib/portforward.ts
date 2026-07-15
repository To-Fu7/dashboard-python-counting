// Manages raw TCP port-forwards for camera RTSP streams via a DEDICATED,
// dashboard-owned nginx container (`edge-portfwd-nginx`, defined in
// dashboard/docker-compose.yml) whose ENTIRE nginx.conf this module owns and
// regenerates from scratch on every save.
//
// Why a dedicated container (vs. editing some other stack's shared nginx):
//   * Isolation — this nginx does nothing but Layer-4 (ngx_stream_core_module)
//     TCP proxying, so a bad forward can only ever break port-forwarding, never
//     a web/admin/reverse-proxy stack that happens to share the box.
//   * Full control — its whole 5500-5600 host-port range is published up front
//     in compose, so the dashboard can pick any listen port in that range and
//     it's already reachable from the host with NO container recreate. (Docker
//     can't add published ports to a running container; pre-publishing the
//     range is what makes forwarding fully dashboard-managed.)
//   * The official nginx image is built --with-stream, so there's no module
//     preflight to do (unlike a random shared/rtmp build).
//
// Because we own the whole file, config generation is a plain full rewrite:
// no marker comments, no byte-for-byte preservation, no brace-depth parsing.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { listEnvFiles, readDeviceEnv } from './env-parser';
import { readSettings } from './settings';

const execAsync = promisify(exec);

// Host-port range published by the edge-portfwd-nginx service in
// docker-compose.yml. A listen port MUST fall inside this range or the forward
// won't be reachable from the host. Keep these two in sync with the compose
// `ports:` mapping — shifting one without the other silently breaks forwards.
export const LISTEN_PORT_MIN = 5500;
export const LISTEN_PORT_MAX = 5600;

export interface PortForward {
  deviceCode: string;
  listenPort: string;
  srcIp: string;
  srcPort: string;
}

export function collectPortForwards(): PortForward[] {
  const forwards: PortForward[] = [];
  for (const code of listEnvFiles()) {
    const env = readDeviceEnv(code);
    if (!env || env.PORTFWD_ENABLED !== 'true') continue;
    if (!env.PORTFWD_LISTEN_PORT || !env.PORTFWD_SRC_IP) continue;
    forwards.push({
      deviceCode: code,
      listenPort: env.PORTFWD_LISTEN_PORT,
      srcIp: env.PORTFWD_SRC_IP,
      srcPort: env.PORTFWD_SRC_PORT || '554',
    });
  }
  return forwards;
}

// Returns a human-readable conflict reason, or null if the port is usable.
// Checks (1) it's a valid port inside the published range, and (2) no other
// dashboard-managed device already forwards it. This is a registry check
// against known dashboard state, NOT a live OS-level socket probe.
export function findPortConflict(listenPort: string, excludeDeviceCode?: string): string | null {
  const n = Number(listenPort);
  if (!Number.isInteger(n) || n < LISTEN_PORT_MIN || n > LISTEN_PORT_MAX) {
    return `Port must be a number between ${LISTEN_PORT_MIN} and ${LISTEN_PORT_MAX} (the range published by the port-forward nginx container)`;
  }
  for (const fwd of collectPortForwards()) {
    if (fwd.deviceCode === excludeDeviceCode) continue;
    if (fwd.listenPort === listenPort) {
      return `Port ${listenPort} is already forwarded by device ${fwd.deviceCode}`;
    }
  }
  return null;
}

// Builds the COMPLETE nginx.conf for the dedicated forwarder — a stream-only
// config with one server{} per forward. With zero forwards the stream{} block
// is empty, which is valid (nginx just listens on nothing).
export function buildNginxConf(forwards: PortForward[]): string {
  const servers = forwards
    .map(f => `    server {
        listen ${f.listenPort} so_keepalive=on;
        proxy_connect_timeout 2s;
        proxy_pass ${f.srcIp}:${f.srcPort};
        proxy_timeout 10m;
    }`)
    .join('\n');
  return `# ============================================================
# Managed ENTIRELY by the EPiWalk dashboard — do not edit by hand.
# Regenerated from scratch on every device save from each device's
# PORTFWD_* vars. Container: edge-portfwd-nginx (dashboard-owned,
# stream-only L4 TCP proxy for RTSP passthrough).
# ============================================================
worker_processes auto;

events {
    worker_connections 1024;
}

stream {
${servers}
}
`;
}

export interface DeployResult {
  deployed: boolean;
  // true when there was nothing to do because the feature is turned off (no
  // nginx container configured). Callers should treat this as benign, NOT as a
  // deploy failure to surface to the user.
  skipped?: boolean;
  error?: string;
}

// Regenerates the dedicated forwarder's whole nginx.conf from the current set
// of dashboard-managed forwards, validates the candidate with `nginx -t`
// BEFORE touching the live file, and only then swaps it in and reloads. An
// invalid candidate never reaches the real nginx.conf path.
export async function deployPortForwardConfig(): Promise<DeployResult> {
  const settings = readSettings();
  const containerName = settings.portForward?.nginxContainerName;
  if (!containerName) {
    return { deployed: false, skipped: true, error: 'nginx container name not configured in Settings' };
  }
  const configPath = settings.portForward?.nginxConfigPath || '/etc/nginx/nginx.conf';
  const candidatePath = `${configPath}.candidate`;

  const newConf = buildNginxConf(collectPortForwards());

  const tmpFile = path.join(os.tmpdir(), `nginx-candidate-${Date.now()}.conf`);
  fs.writeFileSync(tmpFile, newConf, 'utf-8');

  try {
    // Stage the candidate at a NON-bind-mounted path (docker cp works there)
    // and validate it before it can ever affect the running config.
    await execAsync(`docker cp "${tmpFile}" ${containerName}:"${candidatePath}"`, { timeout: 10000 });

    try {
      await execAsync(`docker exec ${containerName} nginx -t -c "${candidatePath}"`, { timeout: 10000 });
    } catch (e) {
      await execAsync(`docker exec ${containerName} rm -f "${candidatePath}"`, { timeout: 5000 }).catch(() => {});
      return { deployed: false, error: `nginx -t validation failed, live config left untouched: ${errMessage(e)}` };
    }

    // configPath is the bind-mounted file (dashboard/nginx/portfwd-nginx.conf).
    // `cp`/`docker cp` unlink+recreate the destination inode, which fails on a
    // bind mount ("device or resource busy"). Writing via a shell redirect
    // truncates-in-place instead, which works on a bind mount the same way
    // `> file` always has — and persists to the host file across recreate.
    await execAsync(
      `docker exec -i ${containerName} sh -c 'cat > "${configPath}"' < "${tmpFile}"`,
      { timeout: 10000 }
    );
    await execAsync(`docker exec ${containerName} rm -f "${candidatePath}"`, { timeout: 5000 }).catch(() => {});
    await execAsync(`docker exec ${containerName} nginx -s reload`, { timeout: 10000 });
    return { deployed: true };
  } catch (e) {
    return { deployed: false, error: errMessage(e) };
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

function errMessage(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  return err.stderr || err.message || String(e);
}
