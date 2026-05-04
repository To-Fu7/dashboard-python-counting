import fs from 'fs';
import path from 'path';
import { DeviceEnvConfig } from './types';

const PYTHON_COUNTING_DIR = process.env.PYTHON_COUNTING_DIR || path.join(process.cwd(), '..', 'python-counting');

export function getEnvFilePath(deviceCode: string): string {
  return path.join(PYTHON_COUNTING_DIR, `.env_${deviceCode}`);
}

export function parseEnvFile(filePath: string): DeviceEnvConfig {
  const content = fs.readFileSync(filePath, 'utf-8');
  const config: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Strip surrounding quotes
    if ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }

    config[key] = value;
  }

  return config as DeviceEnvConfig;
}

export function readDeviceEnv(deviceCode: string): DeviceEnvConfig | null {
  const filePath = getEnvFilePath(deviceCode);
  if (!fs.existsSync(filePath)) return null;
  return parseEnvFile(filePath);
}

export function writeDeviceEnv(deviceCode: string, config: Partial<DeviceEnvConfig>): void {
  const filePath = getEnvFilePath(deviceCode);

  // Build lines with section comments
  const lines: string[] = [
    '# DEVICE INFO',
    `DEVICE_ID=${config.DEVICE_ID ?? ''}`,
    `DEVICE_NAME=${config.DEVICE_NAME ?? ''}`,
    `DEVICE_CODE=${config.DEVICE_CODE ?? deviceCode}`,
    '',
    '# DB CONNECTION',
    `PG_HOST=${config.PG_HOST ?? 'host.docker.internal'}`,
    `PG_PORT=${config.PG_PORT ?? '5432'}`,
    `PG_DB=${config.PG_DB ?? 'postgres'}`,
    `PG_USER=${config.PG_USER ?? 'postgres'}`,
    `PG_PASS=${config.PG_PASS ?? ''}`,
    '',
    '# MQTT',
    `MQTT_BROKER=${config.MQTT_BROKER ?? ''}`,
    `MQTT_PORT=${config.MQTT_PORT ?? '1883'}`,
    `MQTT_USERNAME=${config.MQTT_USERNAME ?? ''}`,
    `MQTT_PASSWORD=${config.MQTT_PASSWORD ?? ''}`,
    '',
    '# MQTT TOPICS',
    `MQTT_TOPIC=${config.MQTT_TOPIC ?? '/person_in'}`,
    `MQTT_INTERVAL_TOPIC=${config.MQTT_INTERVAL_TOPIC ?? ''}`,
    `MQTT_INTERVAL_MINUTES=${config.MQTT_INTERVAL_MINUTES ?? '5'}`,
    `DAILY_SEND_TIME=${config.DAILY_SEND_TIME ?? '23:59'}`,
    '',
    '# STREAM',
    `RTSP_URL=${config.RTSP_URL ?? ''}`,
    `DEBUG_MODE=${config.DEBUG_MODE ?? 'false'}`,
    '',
    '# VIDEO',
    `SCREEN_RESOLUTION=${config.SCREEN_RESOLUTION ?? '[800, 600]'}`,
    `DETECTION_MARGIN=${config.DETECTION_MARGIN ?? '30'}`,
    '',
    '# YOLO',
    `YOLO_MODEL=${config.YOLO_MODEL ?? 'yolo11n.pt'}`,
    `YOLO_CONFIDENCE=${config.YOLO_CONFIDENCE ?? '0.3'}`,
    `ENABLE_NVDEC=${config.ENABLE_NVDEC ?? 'false'}`,
    `JPEG_QUALITY=${config.JPEG_QUALITY ?? '40'}`,
    `FPS_LIMIT=${config.FPS_LIMIT ?? '0'}`,
    `FRAME_SKIP=${config.FRAME_SKIP ?? '2'}`,
    '',
    '# DETECTION',
    `POINT_AXIS=${config.POINT_AXIS ?? 'Y'}`,
    `MERGE_GATES=${config.MERGE_GATES ?? 'false'}`,
    `SWAP_IN_OUT=${config.SWAP_IN_OUT ?? 'false'}`,
    `DETECTION_STYLE=${config.DETECTION_STYLE ?? 'dot'}`,
    `DOT_OFFSET=${config.DOT_OFFSET ?? 'Y'}`,
    `DOT_OFFSET_AMOUNT=${config.DOT_OFFSET_AMOUNT ?? '0'}`,
    `LINE_OFFSET=${config.LINE_OFFSET ?? 'Y'}`,
    `LINE_OFFSET_AMOUNT=${config.LINE_OFFSET_AMOUNT ?? '5'}`,
    '',
    '# LINES',
  ];

  // Write all line* keys (lineA, lineC, lineE, ...)
  const lineKeys = Object.keys(config)
    .filter(k => /^line[A-Z]$/.test(k))
    .sort();
  for (const key of lineKeys) {
    if (config[key]) {
      lines.push(`${key}=${config[key]}`);
    }
  }

  lines.push('');
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

export function deleteDeviceEnv(deviceCode: string): void {
  const filePath = getEnvFilePath(deviceCode);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function listEnvFiles(): string[] {
  if (!fs.existsSync(PYTHON_COUNTING_DIR)) return [];
  return fs.readdirSync(PYTHON_COUNTING_DIR)
    .filter(f => f.startsWith('.env_') && f !== '.env')
    .map(f => f.replace('.env_', ''));
}
