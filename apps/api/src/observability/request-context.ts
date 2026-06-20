import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  correlationId: string;
  requestId: string;
  method: string;
  path: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function enterRequestContext(context: RequestContext): void {
  storage.enterWith(context);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function newRequestId(): string {
  return randomUUID();
}

export function normalizeHeaderId(value: unknown): string | undefined {
  const rawValue = Array.isArray(value) ? value[0] : value;

  if (typeof rawValue !== 'string') {
    return undefined;
  }

  const trimmed = rawValue.trim();

  if (trimmed.length === 0 || trimmed.length > 160) {
    return undefined;
  }

  if (!/^[a-zA-Z0-9._:/=@+-]+$/.test(trimmed)) {
    return undefined;
  }

  return trimmed;
}

export function withCurrentCorrelation<T extends Record<string, unknown>>(payload: T): T {
  const correlationId = getCorrelationId();

  if (correlationId === undefined) {
    return payload;
  }

  return {
    ...payload,
    correlation_id: correlationId
  };
}

export function currentCorrelationHeaders(): Record<string, string> {
  const context = getRequestContext();

  if (context === undefined) {
    return {};
  }

  return {
    'x-request-id': context.requestId,
    'x-correlation-id': context.correlationId
  };
}
