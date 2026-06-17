import { InternalServerErrorException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import type {
  GeoPoint,
  HostProfileRecord,
  PrivateProfileRecord,
  ProfilesApiRepository,
  PublicProfileRecord,
  UpdateProfileInput
} from './profiles.types';

interface PrivateProfileRow {
  id: string;
  phone: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  interests: string[];
  home_location_lat: number | string | null;
  home_location_lng: number | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

type PublicProfileRow = Omit<PrivateProfileRow, 'phone' | 'created_at' | 'updated_at'>;

interface HostProfileRow {
  id: string;
  profile_id: string;
  is_verified: boolean;
  payout_ref: string | null;
  rating: number | string;
  total_activities: number;
  created_at: Date | string;
  updated_at: Date | string;
}

@Injectable()
export class PostgresProfilesApiRepository implements ProfilesApiRepository, OnModuleDestroy {
  private pool: Pool | undefined;

  async getPrivateProfile(profileId: string): Promise<PrivateProfileRecord | undefined> {
    try {
      const result = await this.getPool().query<PrivateProfileRow>(
        `
          select
            id,
            phone,
            display_name,
            avatar_url,
            bio,
            interests,
            st_y(home_location::geometry) as home_location_lat,
            st_x(home_location::geometry) as home_location_lng,
            created_at,
            updated_at
          from profiles
          where id = $1
        `,
        [profileId]
      );

      return mapPrivateProfile(result.rows[0]);
    } catch (error) {
      throw toRepositoryError(error, 'Failed to read profile');
    }
  }

  async updatePrivateProfile(
    profileId: string,
    input: UpdateProfileInput
  ): Promise<PrivateProfileRecord | undefined> {
    const assignments: string[] = [];
    const values: unknown[] = [profileId];
    let parameterIndex = 2;

    if (input.display_name !== undefined) {
      assignments.push(`display_name = $${parameterIndex}`);
      values.push(input.display_name);
      parameterIndex += 1;
    }

    if (input.bio !== undefined) {
      assignments.push(`bio = $${parameterIndex}`);
      values.push(input.bio);
      parameterIndex += 1;
    }

    if (input.interests !== undefined) {
      assignments.push(`interests = $${parameterIndex}::text[]`);
      values.push(input.interests);
      parameterIndex += 1;
    }

    if (input.avatar_url !== undefined) {
      assignments.push(`avatar_url = $${parameterIndex}`);
      values.push(input.avatar_url);
      parameterIndex += 1;
    }

    if (input.home_location !== undefined) {
      if (input.home_location === null) {
        assignments.push('home_location = null');
      } else {
        assignments.push(
          `home_location = st_setsrid(st_makepoint($${parameterIndex}, $${
            parameterIndex + 1
          }), 4326)::geography`
        );
        values.push(input.home_location.lng, input.home_location.lat);
        parameterIndex += 2;
      }
    }

    if (assignments.length === 0) {
      return this.getPrivateProfile(profileId);
    }

    try {
      const result = await this.getPool().query<PrivateProfileRow>(
        `
          update profiles
          set ${assignments.join(', ')}
          where id = $1
          returning
            id,
            phone,
            display_name,
            avatar_url,
            bio,
            interests,
            st_y(home_location::geometry) as home_location_lat,
            st_x(home_location::geometry) as home_location_lng,
            created_at,
            updated_at
        `,
        values
      );

      return mapPrivateProfile(result.rows[0]);
    } catch (error) {
      throw toRepositoryError(error, 'Failed to update profile');
    }
  }

  async getPublicProfile(profileId: string): Promise<PublicProfileRecord | undefined> {
    try {
      const result = await this.getPool().query<PublicProfileRow>(
        `
          select
            id,
            display_name,
            avatar_url,
            bio,
            interests,
            st_y(home_location::geometry) as home_location_lat,
            st_x(home_location::geometry) as home_location_lng
          from profiles
          where id = $1
        `,
        [profileId]
      );

      return mapPublicProfile(result.rows[0]);
    } catch (error) {
      throw toRepositoryError(error, 'Failed to read public profile');
    }
  }

  async becomeHost(profileId: string): Promise<HostProfileRecord | undefined> {
    try {
      const insertResult = await this.getPool().query<HostProfileRow>(
        `
          insert into host_profiles (profile_id)
          select id
          from profiles
          where id = $1
          on conflict (profile_id) do nothing
          returning
            id,
            profile_id,
            is_verified,
            payout_ref,
            rating::float8 as rating,
            total_activities,
            created_at,
            updated_at
        `,
        [profileId]
      );
      const insertedHostProfile = mapHostProfile(insertResult.rows[0]);

      if (insertedHostProfile !== undefined) {
        return insertedHostProfile;
      }

      const existingResult = await this.getPool().query<HostProfileRow>(
        `
          select
            id,
            profile_id,
            is_verified,
            payout_ref,
            rating::float8 as rating,
            total_activities,
            created_at,
            updated_at
          from host_profiles
          where profile_id = $1
        `,
        [profileId]
      );

      return mapHostProfile(existingResult.rows[0]);
    } catch (error) {
      throw toRepositoryError(error, 'Failed to create host profile');
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool !== undefined) {
      await this.pool.end();
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

function mapPrivateProfile(row: PrivateProfileRow | undefined): PrivateProfileRecord | undefined {
  if (row === undefined) {
    return undefined;
  }

  return {
    id: row.id,
    phone: row.phone,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    bio: row.bio,
    interests: row.interests,
    home_location: mapGeoPoint(row),
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at)
  };
}

function mapPublicProfile(row: PublicProfileRow | undefined): PublicProfileRecord | undefined {
  if (row === undefined) {
    return undefined;
  }

  return {
    id: row.id,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    bio: row.bio,
    interests: row.interests,
    home_location: mapGeoPoint(row)
  };
}

function mapHostProfile(row: HostProfileRow | undefined): HostProfileRecord | undefined {
  if (row === undefined) {
    return undefined;
  }

  return {
    id: row.id,
    profile_id: row.profile_id,
    is_verified: row.is_verified,
    payout_ref: row.payout_ref,
    rating: Number(row.rating),
    total_activities: row.total_activities,
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at)
  };
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

function toRepositoryError(error: unknown, message: string): InternalServerErrorException {
  if (error instanceof InternalServerErrorException) {
    return error;
  }

  return new InternalServerErrorException(message);
}
