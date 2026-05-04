import Dockerode from 'dockerode';
import { ContainerStatus } from './types';

let docker: Dockerode | null = null;

function getDocker(): Dockerode {
  if (!docker) {
    docker = new Dockerode({ socketPath: '/var/run/docker.sock' });
  }
  return docker;
}

export function mapDockerState(state: string): ContainerStatus {
  switch (state?.toLowerCase()) {
    case 'running': return 'running';
    case 'exited':
    case 'stopped':
    case 'created': return 'stopped';
    case 'restarting':
    case 'paused': return 'error';
    default: return 'unknown';
  }
}

export async function getContainerStatus(containerName: string): Promise<ContainerStatus> {
  try {
    const d = getDocker();
    const container = d.getContainer(containerName);
    const info = await container.inspect();
    return mapDockerState(info.State.Status);
  } catch {
    return 'not_found';
  }
}

export async function getAllContainerStatuses(containerNames: string[]): Promise<Record<string, ContainerStatus>> {
  const result: Record<string, ContainerStatus> = {};
  await Promise.all(
    containerNames.map(async (name) => {
      result[name] = await getContainerStatus(name);
    })
  );
  return result;
}

export async function startContainer(containerName: string): Promise<void> {
  const d = getDocker();
  const container = d.getContainer(containerName);
  await container.start();
}

export async function stopContainer(containerName: string): Promise<void> {
  const d = getDocker();
  const container = d.getContainer(containerName);
  await container.stop({ t: 10 });
}

export async function restartContainer(containerName: string): Promise<void> {
  const d = getDocker();
  const container = d.getContainer(containerName);
  await container.restart({ t: 10 });
}

export async function getContainerLogs(
  containerName: string,
  tail: number = 100,
  since?: number
): Promise<string[]> {
  try {
    const d = getDocker();
    const container = d.getContainer(containerName);
    const opts = {
      stdout: true,
      stderr: true,
      tail,
      timestamps: true,
      follow: false as const,
      ...(since ? { since } : {}),
    };

    const buffer = await container.logs(opts) as Buffer;
    return parseDockerLogs(buffer);
  } catch {
    return [];
  }
}

function parseDockerLogs(buf: Buffer): string[] {
  const lines: string[] = [];
  let i = 0;
  let pending = '';

  while (i < buf.length) {
    if (i + 8 > buf.length) break;
    const size = buf.readUInt32BE(i + 4);
    i += 8;
    if (size === 0) continue;
    if (i + size > buf.length) break;

    pending += buf.subarray(i, i + size).toString('utf-8');
    i += size;

    const parts = pending.split('\n');
    pending = parts.pop()!;
    for (const part of parts) {
      lines.push(part);
    }
  }

  if (pending) lines.push(pending);

  // Fallback: non-multiplexed logs (e.g. TTY containers)
  if (lines.length === 0 && buf.length > 0) {
    return buf.toString('utf-8').split('\n').filter(Boolean);
  }

  return lines;
}
