import { Module } from '@nestjs/common';

import { RedisModule } from '../redis/redis.module';
import { OUTBOX_RELAY_REPOSITORY } from './outbox.constants';
import { OutboxHealthController } from './outbox-health.controller';
import { OutboxRelayRunner } from './outbox-relay.runner';
import { OutboxRelayService } from './outbox-relay.service';
import { PostgresOutboxRelayRepository } from './outbox.repository';

@Module({
  imports: [RedisModule],
  controllers: [OutboxHealthController],
  providers: [
    OutboxRelayService,
    OutboxRelayRunner,
    {
      provide: OUTBOX_RELAY_REPOSITORY,
      useClass: PostgresOutboxRelayRepository
    }
  ],
  exports: [OutboxRelayService, OUTBOX_RELAY_REPOSITORY]
})
export class OutboxModule {}
