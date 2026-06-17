import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { ChatsController } from './chats.controller';
import { REALTIME_REPOSITORY } from './realtime.constants';
import { RealtimeDomainEventsConsumer } from './realtime-domain-events.consumer';
import { RealtimeGateway } from './realtime.gateway';
import { PostgresRealtimeRepository } from './realtime.repository';
import { RealtimeService } from './realtime.service';

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [ChatsController],
  providers: [
    RealtimeService,
    RealtimeGateway,
    RealtimeDomainEventsConsumer,
    {
      provide: REALTIME_REPOSITORY,
      useClass: PostgresRealtimeRepository
    }
  ],
  exports: [RealtimeService, RealtimeGateway]
})
export class RealtimeModule {}
