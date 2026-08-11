import { saveSettings, loadSettings } from './config/settings.js';
import { hashPassword } from './utils/password.js';
import { logger } from './utils/logger.js';

// Usage: node dist/set-password.js <mot-de-passe>
const password = process.argv[2];

if (!password || password.length < 8) {
  console.error('Usage: node dist/set-password.js <mot-de-passe> (min 8 caracteres)');
  process.exit(1);
}

const hash = hashPassword(password);
saveSettings({ authPasswordHash: hash });
logger.info('Mot de passe mis a jour dans ~/.derive-option-manager/settings.json');
logger.info('Les sessions existantes restent valides jusqu a expiration.');
process.exit(0);
