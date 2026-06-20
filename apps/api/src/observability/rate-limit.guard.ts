import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException
} from '@nestjs/common';
import type Redis from 'ioredis';

import { REDIS_CLIENT } from '../redis/redis.constants';
import {
  enterRequestContext,
  normalizeHeaderId,
  newRequestId
} from './request-context';

interface HttpRequestLike {
  body?: unknown;
  headers?: Record<string, unknown>;
  ip?: string;
  method?: string;
  routeOptions?: {
    url?: string;
  };
  url?: string;
}

interface HttpResponseLike {
  header(name: string, value: string): HttpResponseLike;
}

interface RateLimitPolicy {
  maxRequests: number;
  windowSeconds: number;
  scope: 'auth' | 'write';
}

const WRITE_METHODS = new Set(['DELETE', 'PATCH', 'POST', 'PUT']);

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<HttpRequestLike>();
    const response = http.getResponse<HttpResponseLike>();
    const method = (request.method ?? 'GET').toUpperCase();
    const path = requestPath(request);
    const requestId =
      normalizeHeaderId(request.headers?.['x-request-id']) ??
      normalizeHeaderId(request.headers?.['x-correlation-id']) ??
      newRequestId();
    const correlationId =
      normalizeHeaderId(request.headers?.['x-correlation-id']) ??
      requestId;

    enterRequestContext({
      requestId,
      correlationId,
      method,
      path
    });
    response.header('x-request-id', requestId);
    response.header('x-correlation-id', correlationId);

    const policy = policyFor(method, path);

    if (policy === undefined) {
      return true;
    }

    const identifier = clientIdentifier(request, policy);
    const key = `rate-limit:${policy.scope}:${method}:${path}:${identifier}`;

    let requestCount: number;
    try {
      requestCount = await this.redis.incr(key);

      if (requestCount === 1) {
        await this.redis.expire(key, policy.windowSeconds);
      }
    } catch {
      throw new ServiceUnavailableException('Rate limiter is unavailable');
    }

    if (requestCount > policy.maxRequests) {
      throw new HttpException('Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }

    return true;
  }
}

function policyFor(method: string, path: string): RateLimitPolicy | undefined {
  if (path === '/health' || path.startsWith('/health/') || path.startsWith('/internal/')) {
    return undefined;
  }

  if (path.startsWith('/auth/')) {
    return {
      scope: 'auth',
      maxRequests: positiveIntegerEnv('RATE_LIMIT_AUTH_MAX', 10),
      windowSeconds: positiveIntegerEnv('RATE_LIMIT_AUTH_WINDOW_SECONDS', 60)
    };
  }

  if (WRITE_METHODS.has(method)) {
    return {
      scope: 'write',
      maxRequests: positiveIntegerEnv('RATE_LIMIT_WRITE_MAX', 60),
      windowSeconds: positiveIntegerEnv('RATE_LIMIT_WRITE_WINDOW_SECONDS', 60)
    };
  }

  return undefined;
}

function clientIdentifier(request: HttpRequestLike, policy: RateLimitPolicy): string {
  if (policy.scope === 'auth' && isRecord(request.body) && typeof request.body.phone === 'string') {
    return `phone:${request.body.phone}`;
  }

  const forwardedFor = normalizeHeaderId(request.headers?.['x-forwarded-for']);

  if (forwardedFor !== undefined) {
    return `ip:${forwardedFor.split(',')[0]?.trim() ?? forwardedFor}`;
  }

  return `ip:${request.ip ?? 'unknown'}`;
}

function requestPath(request: HttpRequestLike): string {
  const routePath = request.routeOptions?.url;

  if (routePath !== undefined && routePath.length > 0) {
    return routePath;
  }

  const url = request.url ?? '/';
  const queryIndex = url.indexOf('?');

  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);

  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
