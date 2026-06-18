import { Module } from '@nestjs/common';

import { ActivitiesModule } from './activities/activities.module';
import { AuthModule } from './auth/auth.module';
import { BookingsModule } from './bookings/bookings.module';
import { HealthController } from './health.controller';
import { NotificationsModule } from './notifications/notifications.module';
import { OutboxModule } from './outbox/outbox.module';
import { PaymentsModule } from './payments/payments.module';
import { PostsModule } from './posts/posts.module';
import { ProfilesModule } from './profiles/profiles.module';
import { RealtimeModule } from './realtime/realtime.module';

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
    OutboxModule
  ],
  controllers: [HealthController]
})
export class AppModule {}
