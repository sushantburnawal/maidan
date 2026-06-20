import type { LoggerService, LogLevel } from '@nestjs/common';

import { getRequestContext } from './request-context';

type JsonLogLevel = 'debug' | 'error' | 'info' | 'warn';

interface LogFields {
  [key: string]: unknown;
}

const LOG_LEVEL_PRIORITY: Record<JsonLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export class JsonLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    writeJsonLog('info', message, { context });
  }

  error(message: unknown, trace?: string, context?: string): void {
    writeJsonLog('error', message, { context, trace });
  }

  warn(message: unknown, context?: string): void {
    writeJsonLog('warn', message, { context });
  }

  debug(message: unknown, context?: string): void {
    writeJsonLog('debug', message, { context });
  }

  verbose(message: unknown, context?: string): void {
    writeJsonLog('debug', message, { context });
  }

  setLogLevels(levels: LogLevel[]): void {
    void levels;
  }
}

export function writeJsonLog(
  level: JsonLogLevel,
  message: unknown,
  fields: LogFields = {}
): void {
  if (!shouldLog(level)) {
    return;
  }

  const requestContext = getRequestContext();
  const payload: LogFields = {
    timestamp: new Date().toISOString(),
    level,
    message: stringifyMessage(message),
    ...dropUndefined(fields)
  };

  if (requestContext !== undefined) {
    payload.request_id = requestContext.requestId;
    payload.correlation_id = requestContext.correlationId;
    payload.method = requestContext.method;
    payload.path = requestContext.path;
  }

  const line = `${JSON.stringify(payload)}\n`;

  if (level === 'error') {
    process.stderr.write(line);
    return;
  }

  process.stdout.write(line);
}

function shouldLog(level: JsonLogLevel): boolean {
  const configuredLevel = normalizeLogLevel(process.env.LOG_LEVEL);

  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[configuredLevel];
}

function normalizeLogLevel(value: string | undefined): JsonLogLevel {
  switch (value?.toLowerCase()) {
    case 'debug':
      return 'debug';
    case 'warn':
    case 'warning':
      return 'warn';
    case 'error':
      return 'error';
    default:
      return 'info';
  }
}

function stringifyMessage(message: unknown): string {
  if (typeof message === 'string') {
    return message;
  }

  if (message instanceof Error) {
    return message.message;
  }

  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

function dropUndefined(fields: LogFields): LogFields {
  const result: LogFields = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }

  return result;
}
