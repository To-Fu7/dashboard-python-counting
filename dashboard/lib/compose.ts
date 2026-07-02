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
  command?: string;
  entrypoint?: string[];
  profiles?: string[];
  ports?: string[];
  depends_on?: string[];
  env_file?: string[];
  volumes?: string[];
  devices?: string[];
  extra_hosts?: string[];
  networks?: string[];
  shm_size?: string;
  environment?: string[];
  deploy?: unknown;
}

export const TRITON_SERVICE_NAME = 'triton';
export const TRITON_BUILDER_SERVICE_NAME = 'triton-model-builder';
export const TRITON_CONTAINER_NAME = 'triton-inference-server';
export const DEFAULT_TRITON_IMAGE_TAG = '24.08';

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

// Camera containers are thin Triton clients since the Triton migration: CPU-only
// in every hardware mode. GPU access (runtime/devices) now lives on the triton
// service, which the hardware mode configures instead.
function buildServiceDefinition(deviceCode: string, _hardwareMode: HardwareMode): ComposeService {
  const containerName = getContainerName(deviceCode);
  return {
    image: 'python-counting-services-python-1:latest',
    container_name: containerName,
    restart: 'unless-stopped',
    env_file: [`.env_${deviceCode}`],
    extra_hosts: ['host.docker.internal:host-gateway'],
    networks: ['envisions'],
    depends_on: [TRITON_SERVICE_NAME],
    volumes: [`${HOST_PYTHON_COUNTING_DIR}:/app`],
    environment: [`TRITON_URL=${TRITON_SERVICE_NAME}:8001`],
  };
}

export function tritonImageForMode(hardwareMode: HardwareMode, imageTag: string = DEFAULT_TRITON_IMAGE_TAG): string {
  const suffix = hardwareMode === 'jetson' ? '-py3-igpu' : '-py3';
  return `nvcr.io/nvidia/tritonserver:${imageTag}${suffix}`;
}

export function buildTritonServiceDefinition(
  hardwareMode: HardwareMode,
  imageTag: string = DEFAULT_TRITON_IMAGE_TAG
): ComposeService {
  const base: ComposeService = {
    image: tritonImageForMode(hardwareMode, imageTag),
    container_name: TRITON_CONTAINER_NAME,
    restart: 'unless-stopped',
    command: 'tritonserver --model-repository=/models --strict-model-config=false',
    shm_size: '1gb',
    ports: ['8000:8000', '8001:8001', '8002:8002'],
    volumes: [`${HOST_PYTHON_COUNTING_DIR}/models:/models`],
    networks: ['envisions'],
  };

  // cpu mode: standard image, onnxruntime-CPU models only — no GPU runtime
  if (hardwareMode === 'cpu') return base;

  return {
    ...base,
    runtime: 'nvidia',
    environment: [
      'NVIDIA_VISIBLE_DEVICES=all',
      'NVIDIA_DRIVER_CAPABILITIES=all',
    ],
  };
}

export function buildModelBuilderServiceDefinition(
  hardwareMode: HardwareMode,
  imageTag: string = DEFAULT_TRITON_IMAGE_TAG
): ComposeService {
  const base: ComposeService = {
    image: tritonImageForMode(hardwareMode, imageTag),
    container_name: TRITON_BUILDER_SERVICE_NAME,
    profiles: ['build'],
    entrypoint: ['/bin/bash', '/tools/build_engine.sh'],
    volumes: [
      `${HOST_PYTHON_COUNTING_DIR}/models:/models`,
      `${HOST_PYTHON_COUNTING_DIR}/tools:/tools:ro`,
    ],
  };

  if (hardwareMode === 'cpu') {
    return { ...base, environment: ['TRT_BACKEND=onnx'] };
  }

  return {
    ...base,
    runtime: 'nvidia',
    environment: [
      'NVIDIA_VISIBLE_DEVICES=all',
      'NVIDIA_DRIVER_CAPABILITIES=all',
    ],
  };
}

function ensureTritonServices(compose: ComposeFile, hardwareMode: HardwareMode, imageTag?: string): void {
  compose.services = compose.services || {};
  compose.services[TRITON_SERVICE_NAME] = buildTritonServiceDefinition(hardwareMode, imageTag);
  compose.services[TRITON_BUILDER_SERVICE_NAME] = buildModelBuilderServiceDefinition(hardwareMode, imageTag);
}

export function addService(deviceCode: string, hardwareMode: HardwareMode = 'jetson', tritonImageTag?: string): void {
  const compose = readCompose();
  const serviceName = getServiceName(deviceCode);

  compose.services = compose.services || {};
  compose.services[serviceName] = buildServiceDefinition(deviceCode, hardwareMode);
  ensureTritonServices(compose, hardwareMode, tritonImageTag);

  if (!compose.networks) {
    compose.networks = { envisions: { driver: 'bridge' } };
  }

  writeCompose(compose);
}

export function applyHardwareModeToAll(hardwareMode: HardwareMode, tritonImageTag?: string): void {
  const compose = readCompose();
  if (!compose.services) return;

  for (const [serviceName, svc] of Object.entries(compose.services)) {
    const envFiles = svc.env_file || [];
    const envFile = envFiles.find(ef => ef.startsWith('.env_'));
    if (!envFile) continue;
    const deviceCode = envFile.replace('.env_', '');
    compose.services[serviceName] = buildServiceDefinition(deviceCode, hardwareMode);
  }
  ensureTritonServices(compose, hardwareMode, tritonImageTag);

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

export async function composeUpTriton(): Promise<void> {
  const { stderr } = await execAsync(
    `${COMPOSE_CMD} up -d --no-deps ${TRITON_SERVICE_NAME}`,
    { cwd: PYTHON_COUNTING_DIR, timeout: 300000 } // image pull can take a while
  );
  if (stderr && /error/i.test(stderr) && !/pulling|creating|starting|created|started/i.test(stderr)) {
    throw new Error(stderr.trim());
  }
}

export async function composeStopTriton(): Promise<void> {
  await execAsync(
    `${COMPOSE_CMD} stop ${TRITON_SERVICE_NAME}`,
    { cwd: PYTHON_COUNTING_DIR, timeout: 60000 }
  );
}

export async function composeRestartTriton(): Promise<void> {
  await composeStopTriton();
  await composeUpTriton();
}

export async function runModelBuilder(force = false): Promise<{ stdout: string; stderr: string }> {
  const forceEnv = force ? '-e FORCE_BUILD=1 ' : '';
  // TensorRT engine builds can take minutes per model
  return execAsync(
    `${COMPOSE_CMD} --profile build run --rm ${forceEnv}${TRITON_BUILDER_SERVICE_NAME}`,
    { cwd: PYTHON_COUNTING_DIR, timeout: 1800000 }
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
