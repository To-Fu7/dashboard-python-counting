import { NextResponse } from 'next/server';
import { listServices, addService, serviceExists } from '@/lib/compose';
import { readDeviceEnv, writeDeviceEnv, listEnvFiles } from '@/lib/env-parser';
import { getAllContainerStatuses } from '@/lib/docker';
import { getContainerName } from '@/lib/compose';
import { readSettings } from '@/lib/settings';
import { v4 as uuidv4 } from 'uuid';

export async function GET() {
  try {
    const services = listServices();
    const containerNames = services.map(s => getContainerName(s.deviceCode));
    const statuses = await getAllContainerStatuses(containerNames);

    const devices = services.map(s => {
      const env = readDeviceEnv(s.deviceCode);
      const containerName = getContainerName(s.deviceCode);
      return {
        deviceCode: s.deviceCode,
        deviceName: env?.DEVICE_NAME || s.deviceCode,
        deviceId: env?.DEVICE_ID || '',
        serviceName: s.serviceName,
        containerName,
        envFile: s.envFile,
        rtspUrl: env?.RTSP_URL || '',
        status: statuses[containerName] || 'unknown',
      };
    });

    // Also include env files not in compose (orphaned)
    const envCodes = listEnvFiles();
    const serviceCodes = new Set(services.map(s => s.deviceCode));
    for (const code of envCodes) {
      if (!serviceCodes.has(code)) {
        const env = readDeviceEnv(code);
        const containerName = getContainerName(code);
        devices.push({
          deviceCode: code,
          deviceName: env?.DEVICE_NAME || code,
          deviceId: env?.DEVICE_ID || '',
          serviceName: '',
          containerName,
          envFile: `.env_${code}`,
          rtspUrl: env?.RTSP_URL || '',
          status: 'not_found',
        });
      }
    }

    return NextResponse.json({ devices });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { deviceCode, deviceName, activityTopic, intervalTopic, rtspUrl } = body;

    if (!deviceCode || !deviceName) {
      return NextResponse.json({ error: 'deviceCode and deviceName are required' }, { status: 400 });
    }

    if (/\s/.test(deviceCode)) {
      return NextResponse.json({ error: 'deviceCode must not contain spaces' }, { status: 400 });
    }

    if (serviceExists(deviceCode)) {
      return NextResponse.json({ error: 'Device with this code already exists' }, { status: 409 });
    }

    const settings = readSettings();
    const deviceId = uuidv4();

    writeDeviceEnv(deviceCode, {
      DEVICE_ID: deviceId,
      DEVICE_NAME: deviceName,
      DEVICE_CODE: deviceCode,
      PG_HOST: settings.pg.host,
      PG_PORT: settings.pg.port,
      PG_DB: settings.pg.db,
      PG_USER: settings.pg.user,
      PG_PASS: settings.pg.pass,
      MQTT_BROKER: settings.mqtt.broker,
      MQTT_PORT: settings.mqtt.port,
      MQTT_USERNAME: settings.mqtt.username,
      MQTT_PASSWORD: settings.mqtt.password,
      MQTT_TOPIC: activityTopic || '/person_in',
      MQTT_INTERVAL_TOPIC: intervalTopic || '',
      MQTT_INTERVAL_MINUTES: settings.defaults.mqtt_interval_minutes,
      DAILY_SEND_TIME: settings.defaults.daily_send_time,
      RTSP_URL: rtspUrl || '',
      DEBUG_MODE: settings.defaults.debug_mode,
      SCREEN_RESOLUTION: '[800, 600]',
      DETECTION_MARGIN: settings.defaults.detection_margin,
      YOLO_MODEL: settings.defaults.yolo_model,
      YOLO_CONFIDENCE: settings.defaults.yolo_confidence,
      ENABLE_NVDEC: settings.defaults.enable_nvdec,
      JPEG_QUALITY: settings.defaults.jpeg_quality,
      FPS_LIMIT: settings.defaults.fps_limit,
      FRAME_SKIP: settings.defaults.frame_skip,
      POINT_AXIS: 'Y',
      MERGE_GATES: 'false',
      SWAP_IN_OUT: 'false',
      DETECTION_STYLE: 'dot',
      DOT_OFFSET: 'Y',
      DOT_OFFSET_AMOUNT: '0',
      LINE_OFFSET: 'Y',
      LINE_OFFSET_AMOUNT: '5',
      lineA: '[(100, 300), (700, 300)]',
    });

    addService(deviceCode, settings.hardwareMode);

    return NextResponse.json({ success: true, deviceCode, deviceId }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
