export interface DeviceEnvConfig {
  DEVICE_ID: string;
  DEVICE_NAME: string;
  DEVICE_CODE: string;
  PG_HOST: string;
  PG_PORT: string;
  PG_DB: string;
  PG_USER: string;
  PG_PASS: string;
  MQTT_BROKER: string;
  MQTT_PORT: string;
  MQTT_USERNAME: string;
  MQTT_PASSWORD: string;
  MQTT_TOPIC: string;
  MQTT_INTERVAL_TOPIC: string;
  RTSP_URL: string;
  DEBUG_MODE: string;
  SCREEN_RESOLUTION: string;
  DETECTION_MARGIN: string;
  YOLO_MODEL: string;
  YOLO_CONFIDENCE: string;
  ENABLE_NVDEC: string;
  JPEG_QUALITY: string;
  FPS_LIMIT: string;
  FRAME_SKIP: string;
  POINT_AXIS: string;
  MERGE_GATES: string;
  SWAP_IN_OUT: string;
  DETECTION_STYLE: string;
  DOT_OFFSET: string;
  DOT_OFFSET_AMOUNT: string;
  LINE_OFFSET: string;
  LINE_OFFSET_AMOUNT: string;
  MQTT_INTERVAL_MINUTES?: string;
  DAILY_SEND_TIME?: string;
  DETECTION_MODE?: string;  // 'line_crossing' | 'zone'
  zoneA?: string;
  zoneB?: string;
  zoneC?: string;
  zoneD?: string;
  zoneE?: string;
  [key: string]: string | undefined;
}

export interface LinePoint {
  x: number;
  y: number;
}

export interface DetectionLine {
  label: string; // 'A', 'C', 'E'...
  points: [LinePoint, LinePoint];
}

export interface DeviceInfo {
  deviceCode: string;
  deviceName: string;
  deviceId: string;
  serviceName: string;
  containerName: string;
  envFile: string;
  status: ContainerStatus;
}

export type ContainerStatus = 'running' | 'stopped' | 'error' | 'unknown' | 'not_found';

export interface ContainerInfo {
  id: string;
  name: string;
  status: ContainerStatus;
  state: string;
  image: string;
}

export type HardwareMode = 'jetson' | 'server' | 'cpu';

export interface GlobalSettings {
  appName: string;
  hardwareMode: HardwareMode;
  pg: {
    host: string;
    port: string;
    db: string;
    user: string;
    pass: string;
  };
  mqtt: {
    broker: string;
    port: string;
    username: string;
    password: string;
  };
  defaults: {
    debug_mode: string;
    mqtt_interval_minutes: string;
    daily_send_time: string;
    yolo_model: string;
    yolo_confidence: string;
    enable_nvdec: string;
    jpeg_quality: string;
    fps_limit: string;
    frame_skip: string;
    detection_margin: string;
  };
}

export const DEFAULT_SETTINGS: GlobalSettings = {
  appName: 'EPiWalk',
  hardwareMode: 'jetson',
  pg: {
    host: 'host.docker.internal',
    port: '5432',
    db: 'postgres',
    user: 'postgres',
    pass: '',
  },
  mqtt: {
    broker: '',
    port: '1883',
    username: '',
    password: '',
  },
  defaults: {
    debug_mode: 'false',
    mqtt_interval_minutes: '5',
    daily_send_time: '23:59',
    yolo_model: 'yolo11n.pt',
    yolo_confidence: '0.3',
    enable_nvdec: 'false',
    jpeg_quality: '40',
    fps_limit: '0',
    frame_skip: '2',
    detection_margin: '30',
  },
};
