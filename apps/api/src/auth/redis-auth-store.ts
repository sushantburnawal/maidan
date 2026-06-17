import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';

import { REDIS_CLIENT } from '../redis/redis.constants';
import type { AuthRedisStore } from './auth.types';

@Injectable()
export class IoredisAuthStore implements AuthRedisStore {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

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
}
