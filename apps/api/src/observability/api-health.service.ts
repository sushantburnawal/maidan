import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { RedisInfrastructure } from '../redis/redis.infrastructure';

export interface DependencyCheck {
  status: 'ok' | 'unhealthy';
  latency_ms: number;
  detail?: string;
}

export interface ReadyResponse {
  status: 'ok' | 'unhealthy';
  service: 'api';
  checks: {
    db: DependencyCheck;
    redis: DependencyCheck;
    ai: DependencyCheck;
  };
}

@Injectable()
export class ApiHealthService implements OnModuleDestroy {
  private pool: Pool | undefined;

  constructor(private readonly redisInfrastructure: RedisInfrastructure) {}

  async readiness(): Promise<ReadyResponse> {
    const [db, redis, ai] = await Promise.all([
      timedCheck(() => this.checkDb()),
      timedCheck(() => this.checkRedis()),
      timedCheck(() => this.checkAi())
    ]);
    const status = [db, redis, ai].every((check) => check.status === 'ok') ? 'ok' : 'unhealthy';

    return {
      status,
      service: 'api',
      checks: {
        db,
        redis,
        ai
      }
    };
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool !== undefined) {
      await this.pool.end();
    }
  }

  private async checkDb(): Promise<void> {
    await this.getPool().query('select 1');
  }

  private async checkRedis(): Promise<void> {
    await this.redisInfrastructure.client.ping();
  }

  private async checkAi(): Promise<void> {
    if (process.env.API_HEALTHCHECK_AI_DISABLED === 'true') {
      return;
    }

    const baseUrl = (process.env.AI_BASE_URL ?? 'http://localhost:8000').replace(/\/+$/, '');
    const response = await fetchWithTimeout(`${baseUrl}/health/ready`, 2_000);

    if (!response.ok) {
      throw new Error(`AI readiness returned ${response.status}`);
    }
  }

  private getPool(): Pool {
    if (this.pool !== undefined) {
      return this.pool;
    }

    const connectionString = process.env.DATABASE_URL;

    if (connectionString === undefined || connectionString.length === 0) {
      throw new Error('DATABASE_URL is not configured');
    }

    this.pool = new Pool({
      connectionString,
      ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : undefined
    });

    return this.pool;
  }
}

async function timedCheck(check: () => Promise<void>): Promise<DependencyCheck> {
  const startedAt = Date.now();

  try {
    await withTimeout(check(), 5_000);

    return {
      status: 'ok',
      latency_ms: Date.now() - startedAt
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      latency_ms: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    return await fetch(url, {
      signal: abortController.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}
