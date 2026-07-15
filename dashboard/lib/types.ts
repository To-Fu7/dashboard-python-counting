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
  CROP_AREA?: string;         // '[(x1,y1),(x2,y2)]' top-left → bottom-right
  ANNOTATED_STREAM?: string;  // 'true' = serve annotated MJPEG with bboxes on device detail page
  STREAM_PORT?: string;       // annotated MJPEG port (default 8090)
  TRITON_MODEL?: string;      // Triton model repository name (e.g. yolo26m_640)
  YOLO_IOU?: string;          // NMS IoU (raw-output fallback path only)
  YOLO_MODEL?: string;        // legacy (pre-Triton); used to derive TRITON_MODEL
  YOLO_CONFIDENCE: string;
  ENABLE_NVDEC?: string;      // legacy (pre-Triton); ignored by the thin client
  PEOPLE_COUNTING_TAG?: string;   // 'info' | 'alarm' tag attached to person_in/out MQTT payloads
  APD_ENABLED?: string;
  APD_MODEL?: string;
  APD_CONFIDENCE?: string;
  APD_TAG?: string;               // 'info' | 'alarm'
  FIRE_SMOKE_ENABLED?: string;
  FIRE_SMOKE_MODEL?: string;
  FIRE_SMOKE_CONFIDENCE?: string;
  FIRE_TAG?: string;               // 'info' | 'alarm'
  SMOKE_TAG?: string;              // 'info' | 'alarm'
  FIRE_SMOKE_COOLDOWN_MINUTES?: string;
  FACE_ENABLED?: string;
  FACE_MODEL?: string;             // YOLOv8-face detector, Triton model repo name
  FACE_EMBED_MODEL?: string;       // ArcFace embedder, Triton model repo name
  FACE_CONFIDENCE?: string;
  FACE_MATCH_THRESHOLD?: string;   // min cosine similarity to call it a match
  FACE_CACHE_REFRESH_MINUTES?: string;
  FACE_CAPTURE_FRAMES?: string;    // best-shot: sightings buffered per track before embedding the best one
  INSIDER_TAG?: string;            // 'info' | 'alarm'
  INTRUDER_TAG?: string;           // 'info' | 'alarm'
  MQTT_APD_TOPIC?: string;
  MQTT_FIRESMOKE_TOPIC?: string;
  MQTT_FACE_TOPIC?: string;
  STREAM_GATEWAY_ALWAYS_ON?: string;  // 'true' = stream-gateway connects to this camera immediately and stays connected regardless of viewers; 'false'/unset = on-demand (connects on first viewer, disconnects after an idle grace period)
  STREAM_GATEWAY_AUDIO?: string;      // 'true' = pass the camera's audio track through to MSE/HLS/WebRTC (AAC/Opus sources only for MSE/HLS; WebRTC additionally needs Opus specifically — see stream-gateway's own docs)
  SUBSTREAM_URL?: string;             // optional lower-resolution RTSP URL (e.g. Hikvision Channel 102) — manual field only, registered as its own independent stream-gateway camera ("<code>_sub"), no automatic grid-vs-fullscreen switching
  PORTFWD_ENABLED?: string;      // 'true' = raw TCP port-forward this device's camera through the existing nginx container's stream{} block
  PORTFWD_SRC_IP?: string;       // camera IP to forward to (defaults to the host part of RTSP_URL)
  PORTFWD_SRC_PORT?: string;     // camera port to forward to (default '554')
  PORTFWD_LISTEN_PORT?: string;  // port nginx listens on for this forward
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

export interface CropRect { x1: number; y1: number; x2: number; y2: number }

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

export interface TritonSettings {
  imageTag: string;       // tritonserver release, e.g. '24.08' (suffix -py3/-py3-igpu is derived from hardware mode)
  defaultModel: string;   // model repository name used for new devices, e.g. 'yolo26m_640'
  faceEmbedModel: string; // ArcFace model repo name used to embed enrollment photos (must match cameras' FACE_EMBED_MODEL)
}

export interface PortForwardSettings {
  // Name of the EXISTING nginx Docker container to manage (not created by
  // this dashboard) — e.g. 'env_services_nginx'. Empty until set once per
  // deployment.
  nginxContainerName: string;
  // Path to nginx.conf INSIDE that container. Defaults to the standard
  // location — override if this deployment's image keeps it elsewhere.
  nginxConfigPath: string;
}

export interface GlobalSettings {
  appName: string;
  hardwareMode: HardwareMode;
  triton: TritonSettings;
  portForward: PortForwardSettings;
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
    activityTopicTemplate: string;   // '{code}' is replaced with the device code at creation time
    intervalTopicTemplate: string;
  };
  defaults: {
    debug_mode: string;
    mqtt_interval_minutes: string;
    daily_send_time: string;
    yolo_confidence: string;
    jpeg_quality: string;
    fps_limit: string;
    frame_skip: string;
    people_counting_tag: string;
    apd_confidence: string;
    apd_tag: string;
    fire_smoke_confidence: string;
    fire_tag: string;
    smoke_tag: string;
    fire_smoke_cooldown_minutes: string;
    face_confidence: string;
    face_match_threshold: string;
    insider_tag: string;
    intruder_tag: string;
    face_cache_refresh_minutes: string;
    face_capture_frames: string;
  };
}

export const DEFAULT_SETTINGS: GlobalSettings = {
  appName: 'EPiWalk',
  hardwareMode: 'jetson',
  triton: {
    imageTag: '24.08',
    defaultModel: 'yolo26m_640',
    faceEmbedModel: '',
  },
  portForward: {
    nginxContainerName: 'edge-portfwd-nginx',
    nginxConfigPath: '/etc/nginx/nginx.conf',
  },
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
    activityTopicTemplate: '/person_in/{code}',
    intervalTopicTemplate: '/resampling_person/{code}',
  },
  defaults: {
    debug_mode: 'false',
    mqtt_interval_minutes: '5',
    daily_send_time: '23:59',
    yolo_confidence: '0.3',
    jpeg_quality: '40',
    fps_limit: '0',
    frame_skip: '2',
    people_counting_tag: 'info',
    apd_confidence: '0.3',
    apd_tag: 'alarm',
    fire_smoke_confidence: '0.3',
    fire_tag: 'alarm',
    smoke_tag: 'alarm',
    fire_smoke_cooldown_minutes: '5',
    face_confidence: '0.5',
    face_match_threshold: '0.5',
    insider_tag: 'info',
    intruder_tag: 'alarm',
    face_cache_refresh_minutes: '10',
    face_capture_frames: '5',
  },
};
