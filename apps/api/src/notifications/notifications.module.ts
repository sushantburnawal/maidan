import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { FcmPushProvider } from './fcm-push.provider';
import {
  NOTIFICATIONS_PRESENCE_CHECKER,
  NOTIFICATIONS_REPOSITORY,
  PUSH_PROVIDER
} from './notifications.constants';
import { NotificationsConsumer } from './notifications.consumer';
import { NotificationsController } from './notifications.controller';
import { PostgresNotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';
import { RedisPresenceChecker } from './redis-presence.checker';

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsConsumer,
    FcmPushProvider,
    {
      provide: NOTIFICATIONS_REPOSITORY,
      useClass: PostgresNotificationsRepository
    },
    {
      provide: NOTIFICATIONS_PRESENCE_CHECKER,
      useClass: RedisPresenceChecker
    },
    {
      provide: PUSH_PROVIDER,
      useExisting: FcmPushProvider
    }
  ],
  exports: [NotificationsService]
})
export class NotificationsModule {}
