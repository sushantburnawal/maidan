import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Buffer } from 'node:buffer';

import { POSTS_REPOSITORY } from './posts.constants';
import type { CreatePostDto } from './dto/create-post.dto';
import type { PostsPageQueryDto } from './dto/posts-page-query.dto';
import type {
  CreatePostInput,
  FeedPostRecord,
  PaginatedPostsResponse,
  PostRecord,
  PostsCursor,
  PostsPageInput,
  PostsRepository
} from './posts.types';

const DEFAULT_POSTS_LIMIT = 20;

@Injectable()
export class PostsService {
  constructor(@Inject(POSTS_REPOSITORY) private readonly repository: PostsRepository) {}

  async createPost(authorId: string, dto: CreatePostDto): Promise<PostRecord> {
    const post = await this.repository.createPost(authorId, toCreatePostInput(dto));

    if (post === undefined) {
      throw new NotFoundException('Linked activity not found');
    }

    return post;
  }

  async findFeed(dto: PostsPageQueryDto): Promise<PaginatedPostsResponse> {
    const input = toPostsPageInput(dto);
    const posts = await this.repository.findFeed({
      ...input,
      limit: input.limit + 1
    });

    return toPaginatedPostsResponse(posts, input.limit);
  }

  async findProfilePosts(
    profileId: string,
    dto: PostsPageQueryDto
  ): Promise<PaginatedPostsResponse> {
    const input = toPostsPageInput(dto);
    const posts = await this.repository.findProfilePosts(profileId, {
      ...input,
      limit: input.limit + 1
    });

    return toPaginatedPostsResponse(posts, input.limit);
  }

  async deletePost(postId: string, authorId: string): Promise<void> {
    const deleted = await this.repository.deletePost(postId, authorId);

    if (!deleted) {
      throw new NotFoundException('Post not found');
    }
  }
}

function toCreatePostInput(dto: CreatePostDto): CreatePostInput {
  return {
    body: dto.body,
    media: dto.media ?? [],
    linked_activity_id: dto.linkedActivityId ?? null
  };
}

function toPostsPageInput(dto: PostsPageQueryDto): PostsPageInput {
  return {
    limit: dto.limit ?? DEFAULT_POSTS_LIMIT,
    cursor: dto.cursor === undefined ? undefined : decodeCursor(dto.cursor)
  };
}

function toPaginatedPostsResponse(
  posts: FeedPostRecord[],
  limit: number
): PaginatedPostsResponse {
  const items = posts.slice(0, limit);
  const lastItem = items.at(-1);

  return {
    items,
    next_cursor: posts.length > limit && lastItem !== undefined ? encodeCursor(lastItem) : null
  };
}

function encodeCursor(post: PostRecord): string {
  const cursor: PostsCursor = {
    created_at: post.created_at,
    id: post.id
  };

  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): PostsCursor {
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

function isCursor(value: unknown): value is PostsCursor {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<PostsCursor>;

  return (
    typeof candidate.created_at === 'string' &&
    !Number.isNaN(new Date(candidate.created_at).getTime()) &&
    typeof candidate.id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      candidate.id
    )
  );
}
