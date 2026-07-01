import {
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
import { FollowsPageQueryDto } from './dto/follows-page-query.dto';
import { FollowsService } from './follows.service';
import type { PaginatedFollowsResponse } from './follows.types';

@Controller()
export class FollowsController {
  constructor(private readonly followsService: FollowsService) {}

  @Post('profiles/:id/follow')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  async follow(
    @CurrentUser('profileId') profileId: string,
    @Param('id', ParseUUIDPipe) followeeId: string
  ): Promise<void> {
    await this.followsService.follow(profileId, followeeId);
  }

  @Delete('profiles/:id/follow')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  async unfollow(
    @CurrentUser('profileId') profileId: string,
    @Param('id', ParseUUIDPipe) followeeId: string
  ): Promise<void> {
    await this.followsService.unfollow(profileId, followeeId);
  }

  @Get('profiles/:id/followers')
  @UseGuards(OptionalJwtAuthGuard)
  async findFollowers(
    @Param('id', ParseUUIDPipe) profileId: string,
    @Query() query: FollowsPageQueryDto,
    @CurrentUser('profileId') viewerId?: string
  ): Promise<PaginatedFollowsResponse> {
    return this.followsService.findFollowers(profileId, query, viewerId);
  }

  @Get('profiles/:id/following')
  @UseGuards(OptionalJwtAuthGuard)
  async findFollowing(
    @Param('id', ParseUUIDPipe) profileId: string,
    @Query() query: FollowsPageQueryDto,
    @CurrentUser('profileId') viewerId?: string
  ): Promise<PaginatedFollowsResponse> {
    return this.followsService.findFollowing(profileId, query, viewerId);
  }
}
