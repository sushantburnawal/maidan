import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';

import { realtimeUserPresenceKey } from '../realtime/realtime.constants';
import { REDIS_CLIENT } from '../redis/redis.constants';
import type { PresenceChecker } from './notifications.types';

@Injectable()
export class RedisPresenceChecker implements PresenceChecker {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async isOnline(profileId: string): Promise<boolean> {
    const rawCount = await this.redis.get(realtimeUserPresenceKey(profileId));
    const count = rawCount === null ? 0 : Number(rawCount);

    return Number.isFinite(count) && count > 0;
  }
}
