import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards
} from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { CreatePostDto } from './dto/create-post.dto';
import { PostsPageQueryDto } from './dto/posts-page-query.dto';
import { PostsService } from './posts.service';
import type { PaginatedPostsResponse, PostRecord } from './posts.types';

@Controller()
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

  @Post('posts')
  @UseGuards(JwtAuthGuard)
  async createPost(
    @CurrentUser('profileId') profileId: string,
    @Body() dto: CreatePostDto
  ): Promise<PostRecord> {
    return this.postsService.createPost(profileId, dto);
  }

  @Get('feed')
  @UseGuards(OptionalJwtAuthGuard)
  async findFeed(
    @Query() query: PostsPageQueryDto,
    @CurrentUser('profileId') profileId?: string
  ): Promise<PaginatedPostsResponse> {
    return this.postsService.findFeed(query, profileId);
  }

  @Get('profiles/:id/posts')
  async findProfilePosts(
    @Param('id', ParseUUIDPipe) profileId: string,
    @Query() query: PostsPageQueryDto
  ): Promise<PaginatedPostsResponse> {
    return this.postsService.findProfilePosts(profileId, query);
  }

  @Delete('posts/:id')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  async deletePost(
    @CurrentUser('profileId') profileId: string,
    @Param('id', ParseUUIDPipe) postId: string
  ): Promise<void> {
    await this.postsService.deletePost(postId, profileId);
  }
}
