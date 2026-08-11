import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

export interface AppSettings {
  wsUrl: string;
  restUrl: string;
  sessionKey: string;
  sessionSecret: string;
  subaccountId: number;
  breakEvenOffsetPct: number;
  pollIntervalMs: number;
  logLevel: string;
  authPasswordHash: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  wsUrl: 'wss://api.lyra.finance/ws',
  restUrl: 'https://api.lyra.finance',
  sessionKey: '',
  sessionSecret: '',
  subaccountId: 0,
  breakEvenOffsetPct: 0.5,
  pollIntervalMs: 5000,
  logLevel: 'info',
  authPasswordHash: '',
};

const SETTINGS_DIR = join(homedir(), '.derive-option-manager');
const SETTINGS_FILE = join(SETTINGS_DIR, 'settings.json');

function ensureDir(): void {
  try {
    mkdirSync(SETTINGS_DIR, { recursive: true });
  } catch {
    // ok
  }
}

export function loadSettings(): AppSettings {
  if (!existsSync(SETTINGS_FILE)) {
    return { ...DEFAULT_SETTINGS };
  }

  try {
    const raw = readFileSync(SETTINGS_FILE, 'utf-8');
    const saved = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Partial<AppSettings>): AppSettings {
  const current = loadSettings();
  const merged = { ...current, ...settings };

  ensureDir();
  writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

export function getSettingsPath(): string {
  return SETTINGS_FILE;
}

export function isConfigured(): boolean {
  const s = loadSettings();
  return !!(s.sessionKey && s.sessionSecret);
}
