import { getConfig } from '../config.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

const RESET = '\x1b[0m';

function shouldLog(level: LogLevel): boolean {
  try {
    const config = getConfig();
    return LEVELS[level] >= LEVELS[config.logLevel as LogLevel];
  } catch {
    return LEVELS[level] >= LEVELS.info;
  }
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  debug(msg: string, ...args: unknown[]) {
    if (shouldLog('debug')) {
      console.debug(`${COLORS.debug}[${formatTimestamp()}] [DEBUG]${RESET} ${msg}`, ...args);
    }
  },
  info(msg: string, ...args: unknown[]) {
    if (shouldLog('info')) {
      console.log(`${COLORS.info}[${formatTimestamp()}] [INFO]${RESET} ${msg}`, ...args);
    }
  },
  warn(msg: string, ...args: unknown[]) {
    if (shouldLog('warn')) {
      console.warn(`${COLORS.warn}[${formatTimestamp()}] [WARN]${RESET} ${msg}`, ...args);
    }
  },
  error(msg: string, ...args: unknown[]) {
    if (shouldLog('error')) {
      console.error(`${COLORS.error}[${formatTimestamp()}] [ERROR]${RESET} ${msg}`, ...args);
    }
  },
};
