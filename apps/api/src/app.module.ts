import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { ActivitiesModule } from './activities/activities.module';
import { AuthModule } from './auth/auth.module';
import { BookingsModule } from './bookings/bookings.module';
import { HealthController } from './health.controller';
import { NotificationsModule } from './notifications/notifications.module';
import { ApiHealthService } from './observability/api-health.service';
import { ErrorEnvelopeFilter } from './observability/error-envelope.filter';
import { InternalMetricsController } from './observability/internal-metrics.controller';
import { RateLimitGuard } from './observability/rate-limit.guard';
import { RequestLoggingInterceptor } from './observability/request-logging.interceptor';
import { OutboxModule } from './outbox/outbox.module';
import { PaymentsModule } from './payments/payments.module';
import { PostsModule } from './posts/posts.module';
import { ProfilesModule } from './profiles/profiles.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RedisModule } from './redis/redis.module';
import { SutradharModule } from './sutradhar/sutradhar.module';

@Module({
  imports: [
    AuthModule,
    ProfilesModule,
    ActivitiesModule,
    BookingsModule,
    PaymentsModule,
    PostsModule,
    RealtimeModule,
    NotificationsModule,
    SutradharModule,
    OutboxModule,
    RedisModule
  ],
  controllers: [HealthController, InternalMetricsController],
  providers: [
    ApiHealthService,
    {
      provide: APP_GUARD,
      useClass: RateLimitGuard
    },
    {
      provide: APP_FILTER,
      useClass: ErrorEnvelopeFilter
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestLoggingInterceptor
    }
  ]
})
export class AppModule {}
