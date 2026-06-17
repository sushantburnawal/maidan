import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PROFILES_API_REPOSITORY } from './profiles.constants';
import { ProfilesController } from './profiles.controller';
import { PostgresProfilesApiRepository } from './profiles.repository';
import { ProfilesService } from './profiles.service';

@Module({
  imports: [AuthModule],
  controllers: [ProfilesController],
  providers: [
    ProfilesService,
    {
      provide: PROFILES_API_REPOSITORY,
      useClass: PostgresProfilesApiRepository
    }
  ]
})
export class ProfilesModule {}
