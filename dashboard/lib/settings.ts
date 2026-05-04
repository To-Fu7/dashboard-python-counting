import fs from 'fs';
import path from 'path';
import { GlobalSettings, DEFAULT_SETTINGS } from './types';

const SETTINGS_FILE = process.env.SETTINGS_FILE || path.join(process.cwd(), 'data', 'settings.json');

function ensureDataDir(): void {
  const dir = path.dirname(SETTINGS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function readSettings(): GlobalSettings {
  ensureDataDir();
  if (!fs.existsSync(SETTINGS_FILE)) {
    return DEFAULT_SETTINGS;
  }
  try {
    const content = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    const parsed = JSON.parse(content);
    return {
      appName: parsed.appName ?? DEFAULT_SETTINGS.appName,
      hardwareMode: parsed.hardwareMode ?? DEFAULT_SETTINGS.hardwareMode,
      pg: { ...DEFAULT_SETTINGS.pg, ...parsed.pg },
      mqtt: { ...DEFAULT_SETTINGS.mqtt, ...parsed.mqtt },
      defaults: { ...DEFAULT_SETTINGS.defaults, ...parsed.defaults },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function writeSettings(settings: GlobalSettings): void {
  ensureDataDir();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}
