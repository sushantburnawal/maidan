import {
  HttpException,
  Injectable,
  InternalServerErrorException,
  OnModuleDestroy
} from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';

import type { ActivityPillar, JsonValue, PostCreatedPayload } from '@maidan/shared';
import type {
  CompactActivityCard,
  CompactActivitySlot,
  CreatePostInput,
  FeedPostRecord,
  PostMedia,
  PostRecord,
  PostsPageInput,
  PostsRepository
} from './posts.types';

interface PostRow {
  id: string;
  author_id: string;
  body: string;
  media: JsonValue;
  linked_activity_id: string | null;
  created_at: Date | string;
}

interface FeedPostRow extends PostRow {
  activity_id: string | null;
  activity_title: string | null;
  activity_pillar: ActivityPillar | null;
  activity_base_price_inr: number | null;
  activity_currency: 'INR' | null;
  activity_fairness_score: number | string | null;
  next_slot_id: string | null;
  next_slot_starts_at: Date | string | null;
  next_slot_ends_at: Date | string | null;
}

@Injectable()
export class PostgresPostsRepository implements PostsRepository, OnModuleDestroy {
  private pool: Pool | undefined;

  async createPost(authorId: string, input: CreatePostInput): Promise<PostRecord | undefined> {
    return this.withTransaction(async (client) => {
      const result = await client.query<PostRow>(
        `
          insert into posts (author_id, body, media, linked_activity_id)
          select $1, $2, $3::jsonb, $4::uuid
          where $4::uuid is null
             or exists (
               select 1
               from activities a
               where a.id = $4::uuid
             )
          returning ${postColumns()}
        `,
        [authorId, input.body, JSON.stringify(input.media), input.linked_activity_id]
      );
      const post = mapPost(result.rows[0]);

      if (post === undefined) {
        return undefined;
      }

      await insertPostCreatedEvent(client, post);

      return post;
    }, 'Failed to create post');
  }

  async findFeed(input: PostsPageInput): Promise<FeedPostRecord[]> {
    try {
      const result = await this.getPool().query<FeedPostRow>(
        feedPostsSql(
          `
          where (p.linked_activity_id is null or a.id is not null)
            and (
              $1::timestamptz is null
              or (p.created_at, p.id) < ($1::timestamptz, $2::uuid)
            )
        `,
          3
        ),
        [input.cursor?.created_at ?? null, input.cursor?.id ?? null, input.limit]
      );

      return result.rows.map(mapFeedPost);
    } catch (error) {
      throw toRepositoryError(error, 'Failed to read feed');
    }
  }

  async findProfilePosts(profileId: string, input: PostsPageInput): Promise<FeedPostRecord[]> {
    try {
      const result = await this.getPool().query<FeedPostRow>(
        feedPostsSql(
          `
          where p.author_id = $1
            and (p.linked_activity_id is null or a.id is not null)
            and (
              $2::timestamptz is null
              or (p.created_at, p.id) < ($2::timestamptz, $3::uuid)
            )
        `,
          4
        ),
        [profileId, input.cursor?.created_at ?? null, input.cursor?.id ?? null, input.limit]
      );

      return result.rows.map(mapFeedPost);
    } catch (error) {
      throw toRepositoryError(error, 'Failed to read profile posts');
    }
  }

  async deletePost(postId: string, authorId: string): Promise<boolean> {
    try {
      const result = await this.getPool().query<{ id: string }>(
        `
          delete from posts
          where id = $1
            and author_id = $2
          returning id
        `,
        [postId, authorId]
      );

      return result.rowCount === 1;
    } catch (error) {
      throw toRepositoryError(error, 'Failed to delete post');
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool !== undefined) {
      await this.pool.end();
    }
  }

  private async withTransaction<T>(
    operation: (client: PoolClient) => Promise<T>,
    errorMessage: string
  ): Promise<T> {
    const client = await this.getPool().connect();

    try {
      await client.query('begin');
      const result = await operation(client);
      await client.query('commit');

      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw toRepositoryError(error, errorMessage);
    } finally {
      client.release();
    }
  }

  private getPool(): Pool {
    if (this.pool !== undefined) {
      return this.pool;
    }

    const connectionString = process.env.DATABASE_URL;

    if (connectionString === undefined || connectionString.length === 0) {
      throw new InternalServerErrorException('DATABASE_URL is not configured');
    }

    this.pool = new Pool({
      connectionString,
      ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : undefined
    });

    return this.pool;
  }
}

function postColumns(alias?: string): string {
  const prefix = alias === undefined ? '' : `${alias}.`;

  return `
    ${prefix}id,
    ${prefix}author_id,
    ${prefix}body,
    ${prefix}media,
    ${prefix}linked_activity_id,
    ${prefix}created_at
  `;
}

function feedPostsSql(whereSql: string, limitParameter: number): string {
  return `
    select
      ${postColumns('p')},
      a.id as activity_id,
      a.title as activity_title,
      a.pillar as activity_pillar,
      a.base_price_inr as activity_base_price_inr,
      a.currency as activity_currency,
      a.fairness_score::float8 as activity_fairness_score,
      next_slot.id as next_slot_id,
      next_slot.starts_at as next_slot_starts_at,
      next_slot.ends_at as next_slot_ends_at
    from posts p
    left join activities a
      on a.id = p.linked_activity_id
     and a.status = 'published'
    left join lateral (
      select s.id, s.starts_at, s.ends_at
      from activity_slots s
      where s.activity_id = a.id
        and s.status = 'open'
        and s.starts_at >= now()
        and s.booked_count < s.capacity
      order by s.starts_at asc
      limit 1
    ) next_slot on true
    ${whereSql}
    order by p.created_at desc, p.id desc
    limit $${limitParameter}
  `;
}

async function insertPostCreatedEvent(client: PoolClient, post: PostRecord): Promise<void> {
  const payload: PostCreatedPayload = {
    post_id: post.id,
    author_id: post.author_id,
    linked_activity_id: post.linked_activity_id,
    body: post.body,
    media_count: post.media.length,
    created_at: post.created_at
  };

  await client.query(
    `
      insert into domain_events (aggregate_type, aggregate_id, event_type, payload)
      values ('post', $1, 'post.created', $2::jsonb)
    `,
    [post.id, JSON.stringify(payload)]
  );
}

function mapPost(row: PostRow | undefined): PostRecord | undefined {
  if (row === undefined) {
    return undefined;
  }

  return mapRequiredPost(row);
}

function mapRequiredPost(row: PostRow): PostRecord {
  return {
    id: row.id,
    author_id: row.author_id,
    body: row.body,
    media: Array.isArray(row.media) ? (row.media as PostMedia) : [],
    linked_activity_id: row.linked_activity_id,
    created_at: toIsoTimestamp(row.created_at)
  };
}

function mapFeedPost(row: FeedPostRow): FeedPostRecord {
  return {
    ...mapRequiredPost(row),
    linked_activity: mapActivityCard(row)
  };
}

function mapActivityCard(row: FeedPostRow): CompactActivityCard | null {
  if (
    row.activity_id === null ||
    row.activity_title === null ||
    row.activity_pillar === null ||
    row.activity_base_price_inr === null ||
    row.activity_currency === null ||
    row.activity_fairness_score === null
  ) {
    return null;
  }

  return {
    id: row.activity_id,
    title: row.activity_title,
    pillar: row.activity_pillar,
    next_slot: mapCompactSlot(row),
    price: {
      amount_inr: row.activity_base_price_inr,
      currency: row.activity_currency
    },
    fairness_score: Math.round(Number(row.activity_fairness_score))
  };
}

function mapCompactSlot(row: FeedPostRow): CompactActivitySlot | null {
  if (
    row.next_slot_id === null ||
    row.next_slot_starts_at === null ||
    row.next_slot_ends_at === null
  ) {
    return null;
  }

  return {
    id: row.next_slot_id,
    starts_at: toIsoTimestamp(row.next_slot_starts_at),
    ends_at: toIsoTimestamp(row.next_slot_ends_at)
  };
}

function toIsoTimestamp(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value).toISOString();
}

function toRepositoryError(error: unknown, message: string): HttpException {
  if (error instanceof HttpException) {
    return error;
  }

  return new InternalServerErrorException(message);
}
