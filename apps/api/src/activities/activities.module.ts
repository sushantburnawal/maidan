import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ACTIVITIES_REPOSITORY } from './activities.constants';
import { ActivitiesController } from './activities.controller';
import { PostgresActivitiesRepository } from './activities.repository';
import { ActivitiesService } from './activities.service';
import { ActivitiesVibeProxy } from './activities-vibe.proxy';

@Module({
  imports: [AuthModule],
  controllers: [ActivitiesController],
  providers: [
    ActivitiesVibeProxy,
    ActivitiesService,
    {
      provide: ACTIVITIES_REPOSITORY,
      useClass: PostgresActivitiesRepository
    }
  ]
})
export class ActivitiesModule {}
