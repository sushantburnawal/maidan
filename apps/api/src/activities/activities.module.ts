import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ACTIVITIES_REPOSITORY } from './activities.constants';
import { ActivitiesController } from './activities.controller';
import { PostgresActivitiesRepository } from './activities.repository';
import { ActivitiesService } from './activities.service';

@Module({
  imports: [AuthModule],
  controllers: [ActivitiesController],
  providers: [
    ActivitiesService,
    {
      provide: ACTIVITIES_REPOSITORY,
      useClass: PostgresActivitiesRepository
    }
  ]
})
export class ActivitiesModule {}
