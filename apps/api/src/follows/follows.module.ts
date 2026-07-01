import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { FOLLOWS_REPOSITORY } from './follows.constants';
import { FollowsController } from './follows.controller';
import { PostgresFollowsRepository } from './follows.repository';
import { FollowsService } from './follows.service';

@Module({
  imports: [AuthModule],
  controllers: [FollowsController],
  providers: [
    FollowsService,
    {
      provide: FOLLOWS_REPOSITORY,
      useClass: PostgresFollowsRepository
    }
  ],
  exports: [FollowsService]
})
export class FollowsModule {}
