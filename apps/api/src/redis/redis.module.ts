import { Module } from '@nestjs/common';

import { REDIS_CLIENT } from './redis.constants';
import { RedisInfrastructure } from './redis.infrastructure';

@Module({
  providers: [
    RedisInfrastructure,
    {
      provide: REDIS_CLIENT,
      useFactory: (infrastructure: RedisInfrastructure) => infrastructure.client,
      inject: [RedisInfrastructure]
    }
  ],
  exports: [RedisInfrastructure, REDIS_CLIENT]
})
export class RedisModule {}
