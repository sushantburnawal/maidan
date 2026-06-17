import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

import type { AuthRedisStore } from './auth.types';

@Injectable()
export class IoredisAuthStore implements AuthRedisStore, OnModuleDestroy {
  private readonly client: Redis;

  constructor() {
    this.client = new Redis(getRedisUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: 1
    });
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async setEx(key: string, seconds: number, value: string): Promise<void> {
    await this.client.setex(key, seconds, value);
  }

  async setPx(key: string, milliseconds: number, value: string): Promise<void> {
    await this.client.psetex(key, milliseconds, value);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.client.expire(key, seconds);
  }

  async pttl(key: string): Promise<number> {
    return this.client.pttl(key);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.status === 'end') {
      return;
    }

    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}

function getRedisUrl(): string {
  if (process.env.REDIS_URL !== undefined && process.env.REDIS_URL.length > 0) {
    return process.env.REDIS_URL;
  }

  const host = process.env.REDIS_HOST ?? 'localhost';
  const port = process.env.REDIS_PORT ?? '6379';

  return `redis://${host}:${port}`;
}
