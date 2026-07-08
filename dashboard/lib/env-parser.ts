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

/** Legacy .env migration: derive the Triton model repo name from a YOLO_MODEL
 *  weights filename, e.g. 'yolo26m.pt' -> 'yolo26m_640'. */
export function deriveTritonModel(yoloModel: string | undefined, imgsz = 640): string {
  const stem = (yoloModel || 'yolo11n.pt').replace(/\.[^.]+$/, '');
  return `${stem}_${imgsz}`;
}

/** Per-type MQTT topic default: a subpath of the device's base MQTT_TOPIC,
 *  e.g. '/person_in/CAM1' + 'apd' -> '/person_in/CAM1/apd'. */
export function deriveTopic(mqttTopic: string | undefined, suffix: string): string {
  return `${mqttTopic ?? '/person_in'}/${suffix}`;
}

export function readDeviceEnv(deviceCode: string): DeviceEnvConfig | null {
  const filePath = getEnvFilePath(deviceCode);
  if (!fs.existsSync(filePath)) return null;
  const config = parseEnvFile(filePath);
  // Migration shim: envs written before the Triton migration have YOLO_MODEL only
  if (!config.TRITON_MODEL && config.YOLO_MODEL) {
    config.TRITON_MODEL = deriveTritonModel(config.YOLO_MODEL);
  }
  return config;
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
    `MQTT_APD_TOPIC=${config.MQTT_APD_TOPIC ?? deriveTopic(config.MQTT_TOPIC, 'apd')}`,
    `MQTT_FIRESMOKE_TOPIC=${config.MQTT_FIRESMOKE_TOPIC ?? deriveTopic(config.MQTT_TOPIC, 'firesmoke')}`,
    `MQTT_FACE_TOPIC=${config.MQTT_FACE_TOPIC ?? deriveTopic(config.MQTT_TOPIC, 'face')}`,
    '',
    '# STREAM',
    `RTSP_URL=${config.RTSP_URL ?? ''}`,
    `DEBUG_MODE=${config.DEBUG_MODE ?? 'false'}`,
    '',
    '# VIDEO',
    `SCREEN_RESOLUTION=${config.SCREEN_RESOLUTION ?? '[800, 600]'}`,
    `CROP_AREA=${config.CROP_AREA ?? ''}`,
    `ANNOTATED_STREAM=${config.ANNOTATED_STREAM ?? 'false'}`,
    `STREAM_PORT=${config.STREAM_PORT ?? '8090'}`,
    '',
    '# INFERENCE (Triton)',
    `TRITON_MODEL=${config.TRITON_MODEL ?? deriveTritonModel(config.YOLO_MODEL)}`,
    `YOLO_CONFIDENCE=${config.YOLO_CONFIDENCE ?? '0.3'}`,
    `YOLO_IOU=${config.YOLO_IOU ?? '0.3'}`,
    `JPEG_QUALITY=${config.JPEG_QUALITY ?? '40'}`,
    `FPS_LIMIT=${config.FPS_LIMIT ?? '0'}`,
    `FRAME_SKIP=${config.FRAME_SKIP ?? '2'}`,
    '',
    '# ADDITIONAL DETECTION',
    `PEOPLE_COUNTING_TAG=${config.PEOPLE_COUNTING_TAG ?? 'info'}`,
    `APD_ENABLED=${config.APD_ENABLED ?? 'false'}`,
    `APD_MODEL=${config.APD_MODEL ?? ''}`,
    `APD_CONFIDENCE=${config.APD_CONFIDENCE ?? '0.3'}`,
    `APD_TAG=${config.APD_TAG ?? 'alarm'}`,
    `FIRE_SMOKE_ENABLED=${config.FIRE_SMOKE_ENABLED ?? 'false'}`,
    `FIRE_SMOKE_MODEL=${config.FIRE_SMOKE_MODEL ?? ''}`,
    `FIRE_SMOKE_CONFIDENCE=${config.FIRE_SMOKE_CONFIDENCE ?? '0.3'}`,
    `FIRE_TAG=${config.FIRE_TAG ?? 'alarm'}`,
    `SMOKE_TAG=${config.SMOKE_TAG ?? 'alarm'}`,
    `FIRE_SMOKE_COOLDOWN_MINUTES=${config.FIRE_SMOKE_COOLDOWN_MINUTES ?? '5'}`,
    `FACE_ENABLED=${config.FACE_ENABLED ?? 'false'}`,
    `FACE_MODEL=${config.FACE_MODEL ?? ''}`,
    `FACE_EMBED_MODEL=${config.FACE_EMBED_MODEL ?? ''}`,
    `FACE_CONFIDENCE=${config.FACE_CONFIDENCE ?? '0.5'}`,
    `FACE_MATCH_THRESHOLD=${config.FACE_MATCH_THRESHOLD ?? '0.5'}`,
    `FACE_CACHE_REFRESH_MINUTES=${config.FACE_CACHE_REFRESH_MINUTES ?? '10'}`,
    `FACE_CAPTURE_FRAMES=${config.FACE_CAPTURE_FRAMES ?? '5'}`,
    `INSIDER_TAG=${config.INSIDER_TAG ?? 'info'}`,
    `INTRUDER_TAG=${config.INTRUDER_TAG ?? 'alarm'}`,
    '',
    '# DETECTION',
    `DETECTION_MODE=${config.DETECTION_MODE ?? 'line_crossing'}`,
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

  // Write line* keys (lineA, lineC, lineE, ...)
  const lineKeys = Object.keys(config)
    .filter(k => /^line[A-Z]$/.test(k))
    .sort();
  for (const key of lineKeys) {
    if (config[key]) lines.push(`${key}=${config[key]}`);
  }

  // Write zone* keys (zoneA, zoneB, ...)
  const zoneKeys = Object.keys(config)
    .filter(k => /^zone[A-Z]$/.test(k))
    .sort();
  if (zoneKeys.length > 0) {
    lines.push('');
    lines.push('# ZONES');
    for (const key of zoneKeys) {
      if (config[key]) lines.push(`${key}=${config[key]}`);
    }
  }

  // Write apdZone*/faceZone* keys — restriction zones for APD/Face detection,
  // independent of DETECTION_MODE (see counting_config.APD_EFFECTIVE_ZONES /
  // FACE_EFFECTIVE_ZONES on the Python side for the fallback rule).
  const apdZoneKeys = Object.keys(config).filter(k => /^apdZone[A-Z]$/.test(k)).sort();
  const faceZoneKeys = Object.keys(config).filter(k => /^faceZone[A-Z]$/.test(k)).sort();
  if (apdZoneKeys.length > 0 || faceZoneKeys.length > 0) {
    lines.push('');
    lines.push('# APD/FACE RESTRICTION ZONES');
    for (const key of apdZoneKeys) {
      if (config[key]) lines.push(`${key}=${config[key]}`);
    }
    for (const key of faceZoneKeys) {
      if (config[key]) lines.push(`${key}=${config[key]}`);
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
