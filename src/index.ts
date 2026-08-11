import { startServer } from './server.js';
import { logger } from './utils/logger.js';

const PORT = parseInt(process.env.PORT || '3001', 10);

logger.info(`Starting Derive Option Manager on port ${PORT}...`);
startServer(PORT);
