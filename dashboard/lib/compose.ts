import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { HardwareMode } from './types';

const execAsync = promisify(exec);

const PYTHON_COUNTING_DIR = process.env.PYTHON_COUNTING_DIR || path.join(process.cwd(), '..', 'python-counting');
// When running inside Docker, PYTHON_COUNTING_DIR is a container-internal path (/python-counting).
// The Docker daemon needs the actual HOST path to resolve relative volume mounts (.:/app).
// HOST_PYTHON_COUNTING_DIR must be set to the host filesystem path of python-counting/.
const HOST_PYTHON_COUNTING_DIR = process.env.HOST_PYTHON_COUNTING_DIR || PYTHON_COUNTING_DIR;
const COMPOSE_FILE = path.join(PYTHON_COUNTING_DIR, 'docker-compose.yml');

interface ComposeService {
  image?: string;
  container_name?: string;
  restart?: string;
  runtime?: string;
  env_file?: string[];
  volumes?: string[];
  devices?: string[];
  extra_hosts?: string[];
  networks?: string[];
  shm_size?: string;
  environment?: string[];
  deploy?: unknown;
}

interface ComposeFile {
  services: Record<string, ComposeService>;
  networks?: Record<string, unknown>;
  [key: string]: unknown;
}

export function readCompose(): ComposeFile {
  if (!fs.existsSync(COMPOSE_FILE)) {
    return {
      services: {},
      networks: { envisions: { driver: 'bridge' } },
    };
  }
  const content = fs.readFileSync(COMPOSE_FILE, 'utf-8');
  return (yaml.load(content) as ComposeFile) || { services: {} };
}

export function writeCompose(compose: ComposeFile): void {
  const content = yaml.dump(compose, { lineWidth: 120, quotingType: '"' });
  fs.writeFileSync(COMPOSE_FILE, content, 'utf-8');
}

export function getServiceName(deviceCode: string): string {
  return `services-python-${deviceCode.toLowerCase().replace(/_/g, '-')}`;
}

export function getContainerName(deviceCode: string): string {
  return `services-python-${deviceCode.toLowerCase().replace(/_/g, '-')}`;
}

export function listServices(): { serviceName: string; deviceCode: string; envFile: string }[] {
  const compose = readCompose();
  const results: { serviceName: string; deviceCode: string; envFile: string }[] = [];

  for (const [name, svc] of Object.entries(compose.services || {})) {
    const envFiles = svc.env_file || [];
    for (const ef of envFiles) {
      if (ef.startsWith('.env_')) {
        const code = ef.replace('.env_', '');
        results.push({ serviceName: name, deviceCode: code, envFile: ef });
        break;
      }
    }
  }

  return results;
}

function buildServiceDefinition(deviceCode: string, hardwareMode: HardwareMode): ComposeService {
  const containerName = getContainerName(deviceCode);
  const base: ComposeService = {
    image: 'python-counting-services-python-1:latest',
    container_name: containerName,
    restart: 'unless-stopped',
    env_file: [`.env_${deviceCode}`],
    extra_hosts: ['host.docker.internal:host-gateway'],
    networks: ['envisions'],
    shm_size: '1gb',
  };

  if (hardwareMode === 'jetson') {
    return {
      ...base,
      volumes: [
        `${HOST_PYTHON_COUNTING_DIR}:/app`,
        '/usr/lib/aarch64-linux-gnu/tegra:/usr/lib/aarch64-linux-gnu/tegra',
        '/usr/lib/aarch64-linux-gnu/tegra-egl:/usr/lib/aarch64-linux-gnu/tegra-egl',
      ],
      devices: [
        '/dev/nvhost-gpu',
        '/dev/nvhost-ctrl',
        '/dev/nvhost-ctrl-gpu',
        '/dev/nvhost-as-gpu',
        '/dev/nvmap',
        '/dev/nvidiactl',
        '/dev/nvhost-vic',
        '/dev/nvhost-nvdec',
      ],
      environment: [
        'NVIDIA_VISIBLE_DEVICES=all',
        'NVIDIA_DRIVER_CAPABILITIES=all',
        'LD_LIBRARY_PATH=/usr/lib/aarch64-linux-gnu/tegra:/usr/lib/aarch64-linux-gnu/tegra-egl',
      ],
    };
  }

  if (hardwareMode === 'server') {
    return {
      ...base,
      runtime: 'nvidia',
      volumes: [`${HOST_PYTHON_COUNTING_DIR}:/app`],
      environment: [
        'NVIDIA_VISIBLE_DEVICES=all',
        'NVIDIA_DRIVER_CAPABILITIES=all',
      ],
    };
  }

  // cpu mode: no GPU runtime or device mappings
  return {
    ...base,
    volumes: [`${HOST_PYTHON_COUNTING_DIR}:/app`],
  };
}

export function addService(deviceCode: string, hardwareMode: HardwareMode = 'jetson'): void {
  const compose = readCompose();
  const serviceName = getServiceName(deviceCode);

  compose.services = compose.services || {};
  compose.services[serviceName] = buildServiceDefinition(deviceCode, hardwareMode);

  if (!compose.networks) {
    compose.networks = { envisions: { driver: 'bridge' } };
  }

  writeCompose(compose);
}

export function applyHardwareModeToAll(hardwareMode: HardwareMode): void {
  const compose = readCompose();
  if (!compose.services) return;

  for (const [serviceName, svc] of Object.entries(compose.services)) {
    const envFiles = svc.env_file || [];
    const envFile = envFiles.find(ef => ef.startsWith('.env_'));
    if (!envFile) continue;
    const deviceCode = envFile.replace('.env_', '');
    compose.services[serviceName] = buildServiceDefinition(deviceCode, hardwareMode);
  }

  writeCompose(compose);
}

export function removeService(deviceCode: string): void {
  const compose = readCompose();
  const serviceName = getServiceName(deviceCode);

  if (compose.services) {
    delete compose.services[serviceName];
  }

  writeCompose(compose);
}

export function serviceExists(deviceCode: string): boolean {
  const compose = readCompose();
  const serviceName = getServiceName(deviceCode);
  return !!compose.services?.[serviceName];
}

const COMPOSE_CMD = `docker compose -f "${COMPOSE_FILE}"`;

export async function composeUp(deviceCode: string): Promise<void> {
  const serviceName = getServiceName(deviceCode);
  const { stderr } = await execAsync(
    `${COMPOSE_CMD} up -d --force-recreate --no-deps ${serviceName}`,
    { cwd: PYTHON_COUNTING_DIR, timeout: 60000 }
  );
  if (stderr && !/pulling|creating|starting|created|started/i.test(stderr)) {
    if (/error/i.test(stderr)) throw new Error(stderr.trim());
  }
}

export async function composeStop(deviceCode: string): Promise<void> {
  const serviceName = getServiceName(deviceCode);
  await execAsync(
    `${COMPOSE_CMD} stop ${serviceName}`,
    { cwd: PYTHON_COUNTING_DIR, timeout: 30000 }
  );
}

export async function composeRestart(deviceCode: string): Promise<void> {
  const serviceName = getServiceName(deviceCode);
  await execAsync(
    `${COMPOSE_CMD} stop ${serviceName}`,
    { cwd: PYTHON_COUNTING_DIR, timeout: 30000 }
  );
  const { stderr } = await execAsync(
    `${COMPOSE_CMD} up -d --force-recreate --no-deps ${serviceName}`,
    { cwd: PYTHON_COUNTING_DIR, timeout: 60000 }
  );
  if (stderr && /error/i.test(stderr) && !/pulling|creating|starting|created|started/i.test(stderr)) {
    throw new Error(stderr.trim());
  }
}

export async function composeUpAll(): Promise<void> {
  await execAsync(
    `${COMPOSE_CMD} up -d`,
    { cwd: PYTHON_COUNTING_DIR, timeout: 120000 }
  );
}

export async function composeBuild(): Promise<{ stdout: string; stderr: string }> {
  return execAsync(
    `${COMPOSE_CMD} build`,
    { cwd: PYTHON_COUNTING_DIR, timeout: 600000 }
  );
}

export async function imageExists(imageName: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`docker image inspect ${imageName} --format "{{.Id}}"`, { timeout: 10000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
