import { InternalServerErrorException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

import type { ProfileRecord, ProfilesRepository } from './auth.types';

interface ProfileRow {
  id: string;
  phone: string;
}

@Injectable()
export class PostgresProfilesRepository implements ProfilesRepository, OnModuleDestroy {
  private pool: Pool | undefined;

  async findOrCreateByPhone(phone: string): Promise<ProfileRecord> {
    const client = await this.getPool().connect();

    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [phone]);

      const existingProfile = await this.findProfileByPhone(client, phone);

      if (existingProfile !== undefined) {
        await client.query('commit');
        return existingProfile;
      }

      const profileId = randomUUID();
      const displayName = defaultDisplayName(phone);

      await client.query(
        `
          insert into auth.users (
            id,
            aud,
            role,
            phone,
            phone_confirmed_at,
            confirmed_at,
            raw_app_meta_data,
            raw_user_meta_data,
            created_at,
            updated_at
          )
          values (
            $1,
            'authenticated',
            'authenticated',
            $2,
            now(),
            now(),
            '{"provider":"phone","providers":["phone"]}'::jsonb,
            jsonb_build_object('display_name', $3, 'phone_first_login', true),
            now(),
            now()
          )
        `,
        [profileId, phone, displayName]
      );

      const createdProfileResult = await client.query<ProfileRow>(
        `
          insert into profiles (id, phone, display_name)
          values ($1, $2, $3)
          returning id, phone
        `,
        [profileId, phone, displayName]
      );
      const createdProfile = createdProfileResult.rows[0];

      if (createdProfile === undefined) {
        throw new Error('profile insert returned no row');
      }

      await client.query('commit');
      return createdProfile;
    } catch (error) {
      await rollback(client);
      throw toRepositoryError(error);
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool !== undefined) {
      await this.pool.end();
    }
  }

  private async findProfileByPhone(
    client: PoolClient,
    phone: string
  ): Promise<ProfileRow | undefined> {
    const result = await client.query<ProfileRow>(
      `
        select id, phone
        from profiles
        where phone = $1
      `,
      [phone]
    );

    return result.rows[0];
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

function defaultDisplayName(phone: string): string {
  return `Maidan Explorer ${phone.slice(-4)}`;
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('rollback');
  } catch {
    // Ignore rollback failures so callers receive the original repository error.
  }
}

function toRepositoryError(error: unknown): InternalServerErrorException {
  if (error instanceof InternalServerErrorException) {
    return error;
  }

  return new InternalServerErrorException('Failed to persist auth profile');
}
