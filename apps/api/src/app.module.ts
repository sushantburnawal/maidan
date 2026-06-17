import { Module } from '@nestjs/common';

import { ActivitiesModule } from './activities/activities.module';
import { AuthModule } from './auth/auth.module';
import { BookingsModule } from './bookings/bookings.module';
import { HealthController } from './health.controller';
import { ProfilesModule } from './profiles/profiles.module';

@Module({
  imports: [AuthModule, ProfilesModule, ActivitiesModule, BookingsModule],
  controllers: [HealthController]
})
export class AppModule {}
