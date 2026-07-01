import {
  HttpException,
  Injectable,
  InternalServerErrorException,
  OnModuleDestroy
} from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';

import type { FollowCreatedPayload, GeoPoint } from '@maidan/shared';
import type {
  FollowCounts,
  FollowCreateResult,
  FollowProfileSummaryRecord,
  FollowRecord,
  FollowsPageInput,
  FollowsRepository
} from './follows.types';

interface FollowRow {
  follower_id: string;
  followee_id: string;
  created_at: Date | string;
}

interface FollowProfileSummaryRow {
  id: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  interests: string[];
  home_location_lat: number | string | null;
  home_location_lng: number | string | null;
  followed_at: Date | string;
  is_following: boolean | null;
}

interface FollowCountsRow {
  follower_count: number | string;
  following_count: number | string;
}

@Injectable()
export class PostgresFollowsRepository implements FollowsRepository, OnModuleDestroy {
  private pool: Pool | undefined;

  async createFollow(followerId: string, followeeId: string): Promise<FollowCreateResult> {
    return this.withTransaction(async (client) => {
      const result = await client.query<FollowRow>(
        `
          insert into follows (follower_id, followee_id)
          select $1, $2
          where exists (
            select 1
            from profiles p
            where p.id = $2
          )
          on conflict (follower_id, followee_id) do nothing
          returning follower_id, followee_id, created_at
        `,
        [followerId, followeeId]
      );
      const follow = mapFollow(result.rows[0]);

      if (follow !== undefined) {
        await insertFollowCreatedEvent(client, follow);

        return {
          status: 'created',
          follow
        };
      }

      if (!(await profileExists(client, followeeId))) {
        return {
          status: 'followee_not_found'
        };
      }

      return {
        status: 'already_exists'
      };
    }, 'Failed to create follow');
  }

  async deleteFollow(followerId: string, followeeId: string): Promise<void> {
    try {
      await this.getPool().query(
        `
          delete from follows
          where follower_id = $1
            and followee_id = $2
        `,
        [followerId, followeeId]
      );
    } catch (error) {
      throw toRepositoryError(error, 'Failed to delete follow');
    }
  }

  async findFollowers(
    profileId: string,
    input: FollowsPageInput
  ): Promise<FollowProfileSummaryRecord[]> {
    try {
      const result = await this.getPool().query<FollowProfileSummaryRow>(
        `
          select
            ${profileSummaryColumns('p')},
            f.created_at as followed_at,
            case
              when $4::uuid is null then null
              else exists (
                select 1
                from follows viewer_follows
                where viewer_follows.follower_id = $4::uuid
                  and viewer_follows.followee_id = p.id
              )
            end as is_following
          from follows f
          join profiles p on p.id = f.follower_id
          where f.followee_id = $1
            and (
              $2::timestamptz is null
              or (f.created_at, p.id) < ($2::timestamptz, $3::uuid)
            )
          order by f.created_at desc, p.id desc
          limit $5
        `,
        [
          profileId,
          input.cursor?.created_at ?? null,
          input.cursor?.id ?? null,
          input.viewerId ?? null,
          input.limit
        ]
      );

      return result.rows.map(mapFollowProfileSummary);
    } catch (error) {
      throw toRepositoryError(error, 'Failed to read followers');
    }
  }

  async findFollowing(
    profileId: string,
    input: FollowsPageInput
  ): Promise<FollowProfileSummaryRecord[]> {
    try {
      const result = await this.getPool().query<FollowProfileSummaryRow>(
        `
          select
            ${profileSummaryColumns('p')},
            f.created_at as followed_at,
            case
              when $4::uuid is null then null
              else exists (
                select 1
                from follows viewer_follows
                where viewer_follows.follower_id = $4::uuid
                  and viewer_follows.followee_id = p.id
              )
            end as is_following
          from follows f
          join profiles p on p.id = f.followee_id
          where f.follower_id = $1
            and (
              $2::timestamptz is null
              or (f.created_at, p.id) < ($2::timestamptz, $3::uuid)
            )
          order by f.created_at desc, p.id desc
          limit $5
        `,
        [
          profileId,
          input.cursor?.created_at ?? null,
          input.cursor?.id ?? null,
          input.viewerId ?? null,
          input.limit
        ]
      );

      return result.rows.map(mapFollowProfileSummary);
    } catch (error) {
      throw toRepositoryError(error, 'Failed to read following');
    }
  }

  async findFolloweeIds(followerId: string): Promise<string[]> {
    try {
      const result = await this.getPool().query<{ followee_id: string }>(
        `
          select followee_id
          from follows
          where follower_id = $1
          order by created_at desc, followee_id desc
        `,
        [followerId]
      );

      return result.rows.map((row) => row.followee_id);
    } catch (error) {
      throw toRepositoryError(error, 'Failed to read followees');
    }
  }

  async getCounts(profileId: string): Promise<FollowCounts> {
    try {
      const result = await this.getPool().query<FollowCountsRow>(
        `
          select
            (
              select count(*)::int
              from follows
              where followee_id = $1
            ) as follower_count,
            (
              select count(*)::int
              from follows
              where follower_id = $1
            ) as following_count
        `,
        [profileId]
      );

      const row = result.rows[0];

      return {
        follower_count: Number(row?.follower_count ?? 0),
        following_count: Number(row?.following_count ?? 0)
      };
    } catch (error) {
      throw toRepositoryError(error, 'Failed to read follow counts');
    }
  }

  async isFollowing(followerId: string, followeeId: string): Promise<boolean> {
    try {
      const result = await this.getPool().query<{ exists: boolean }>(
        `
          select exists (
            select 1
            from follows
            where follower_id = $1
              and followee_id = $2
          )
        `,
        [followerId, followeeId]
      );

      return result.rows[0]?.exists === true;
    } catch (error) {
      throw toRepositoryError(error, 'Failed to read follow state');
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

function profileSummaryColumns(alias: string): string {
  return `
    ${alias}.id,
    ${alias}.display_name,
    ${alias}.avatar_url,
    ${alias}.bio,
    ${alias}.interests,
    st_y(${alias}.home_location::geometry) as home_location_lat,
    st_x(${alias}.home_location::geometry) as home_location_lng
  `;
}

async function profileExists(client: PoolClient, profileId: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `
      select exists (
        select 1
        from profiles
        where id = $1
      )
    `,
    [profileId]
  );

  return result.rows[0]?.exists === true;
}

async function insertFollowCreatedEvent(client: PoolClient, follow: FollowRecord): Promise<void> {
  const payload: FollowCreatedPayload = {
    follower_id: follow.follower_id,
    followee_id: follow.followee_id,
    created_at: follow.created_at
  };

  await client.query(
    `
      insert into domain_events (aggregate_type, aggregate_id, event_type, payload)
      values ('follow', $1, 'follow.created', $2::jsonb)
    `,
    [follow.followee_id, JSON.stringify(payload)]
  );
}

function mapFollow(row: FollowRow | undefined): FollowRecord | undefined {
  if (row === undefined) {
    return undefined;
  }

  return {
    follower_id: row.follower_id,
    followee_id: row.followee_id,
    created_at: toIsoTimestamp(row.created_at)
  };
}

function mapFollowProfileSummary(row: FollowProfileSummaryRow): FollowProfileSummaryRecord {
  const summary: FollowProfileSummaryRecord = {
    id: row.id,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    bio: row.bio,
    interests: row.interests,
    home_location: mapGeoPoint(row),
    followed_at: toIsoTimestamp(row.followed_at)
  };

  if (row.is_following !== null) {
    summary.is_following = row.is_following;
  }

  return summary;
}

function mapGeoPoint(row: {
  home_location_lat: number | string | null;
  home_location_lng: number | string | null;
}): GeoPoint | null {
  if (row.home_location_lat === null || row.home_location_lng === null) {
    return null;
  }

  return {
    lat: Number(row.home_location_lat),
    lng: Number(row.home_location_lng)
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
