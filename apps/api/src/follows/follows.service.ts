import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Buffer } from 'node:buffer';

import { FOLLOWS_REPOSITORY } from './follows.constants';
import type { FollowsPageQueryDto } from './dto/follows-page-query.dto';
import type {
  FollowCounts,
  FollowProfileSummaryRecord,
  FollowsCursor,
  FollowsPageInput,
  FollowsRepository,
  PaginatedFollowsResponse
} from './follows.types';

const DEFAULT_FOLLOWS_LIMIT = 20;

@Injectable()
export class FollowsService {
  constructor(@Inject(FOLLOWS_REPOSITORY) private readonly repository: FollowsRepository) {}

  async follow(followerId: string, followeeId: string): Promise<void> {
    if (followerId === followeeId) {
      throw new BadRequestException('Cannot follow yourself');
    }

    const result = await this.repository.createFollow(followerId, followeeId);

    if (result.status === 'followee_not_found') {
      throw new NotFoundException('Profile not found');
    }
  }

  async unfollow(followerId: string, followeeId: string): Promise<void> {
    await this.repository.deleteFollow(followerId, followeeId);
  }

  async findFollowers(
    profileId: string,
    dto: FollowsPageQueryDto,
    viewerId?: string
  ): Promise<PaginatedFollowsResponse> {
    const input = toFollowsPageInput(dto, viewerId);
    const profiles = await this.repository.findFollowers(profileId, {
      ...input,
      limit: input.limit + 1
    });

    return toPaginatedFollowsResponse(profiles, input.limit);
  }

  async findFollowing(
    profileId: string,
    dto: FollowsPageQueryDto,
    viewerId?: string
  ): Promise<PaginatedFollowsResponse> {
    const input = toFollowsPageInput(dto, viewerId);
    const profiles = await this.repository.findFollowing(profileId, {
      ...input,
      limit: input.limit + 1
    });

    return toPaginatedFollowsResponse(profiles, input.limit);
  }

  async findFolloweeIds(followerId: string): Promise<string[]> {
    return this.repository.findFolloweeIds(followerId);
  }

  async getCounts(profileId: string): Promise<FollowCounts> {
    return this.repository.getCounts(profileId);
  }

  async isFollowing(followerId: string, followeeId: string): Promise<boolean> {
    if (followerId === followeeId) {
      return false;
    }

    return this.repository.isFollowing(followerId, followeeId);
  }
}

function toFollowsPageInput(dto: FollowsPageQueryDto, viewerId: string | undefined): FollowsPageInput {
  return {
    limit: dto.limit ?? DEFAULT_FOLLOWS_LIMIT,
    cursor: dto.cursor === undefined ? undefined : decodeCursor(dto.cursor),
    viewerId
  };
}

function toPaginatedFollowsResponse(
  profiles: FollowProfileSummaryRecord[],
  limit: number
): PaginatedFollowsResponse {
  const pageItems = profiles.slice(0, limit);
  const lastItem = pageItems.at(-1);

  return {
    items: pageItems.map(toFollowProfileSummaryResponse),
    next_cursor:
      profiles.length > limit && lastItem !== undefined ? encodeCursor(lastItem) : null
  };
}

function toFollowProfileSummaryResponse(profile: FollowProfileSummaryRecord) {
  const response = {
    id: profile.id,
    display_name: profile.display_name,
    avatar_url: profile.avatar_url,
    bio: profile.bio,
    interests: profile.interests,
    home_location: profile.home_location
  };

  if (profile.is_following === undefined) {
    return response;
  }

  return {
    ...response,
    is_following: profile.is_following
  };
}

function encodeCursor(profile: FollowProfileSummaryRecord): string {
  const cursor: FollowsCursor = {
    created_at: profile.followed_at,
    id: profile.id
  };

  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): FollowsCursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;

    if (!isCursor(value)) {
      throw new Error('Invalid cursor shape');
    }

    return value;
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}

function isCursor(value: unknown): value is FollowsCursor {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<FollowsCursor>;

  return (
    typeof candidate.created_at === 'string' &&
    !Number.isNaN(new Date(candidate.created_at).getTime()) &&
    typeof candidate.id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      candidate.id
    )
  );
}
