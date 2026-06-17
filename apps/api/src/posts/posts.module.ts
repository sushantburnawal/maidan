import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { POSTS_REPOSITORY } from './posts.constants';
import { PostsController } from './posts.controller';
import { PostgresPostsRepository } from './posts.repository';
import { PostsService } from './posts.service';

@Module({
  imports: [AuthModule],
  controllers: [PostsController],
  providers: [
    PostsService,
    {
      provide: POSTS_REPOSITORY,
      useClass: PostgresPostsRepository
    }
  ]
})
export class PostsModule {}
