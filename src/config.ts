import { loadSettings, isConfigured, type AppSettings } from './config/settings.js';

let _config: AppSettings | null = null;

export function getConfig(): AppSettings {
  if (!_config) {
    if (!isConfigured()) {
      throw new Error('NOT_CONFIGURED');
    }
    _config = loadSettings();
  }
  return _config;
}

export function loadConfig(): AppSettings {
  _config = loadSettings();
  return _config;
}
