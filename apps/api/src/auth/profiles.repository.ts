import { InternalServerErrorException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

import type {
  FirebaseProfileIdentity,
  FirebaseProfileResolution,
  ProfileRecord,
  ProfilesRepository
} from './auth.types';

interface ProfileRow {
  id: string;
  phone: string | null;
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
            email,
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
            '{"provider":"phone","providers":["phone"]}'::jsonb,
            jsonb_build_object('display_name', $3::text),
            now(),
            now()
          )
        `,
        [profileId, authEmail(profileId), displayName]
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

  async resolveFirebaseIdentity(
    identity: FirebaseProfileIdentity
  ): Promise<FirebaseProfileResolution> {
    const client = await this.getPool().connect();
    const normalizedEmail = normalizeEmail(identity.email);

    try {
      await client.query('begin');
      await lockFirebaseIdentity(client, identity.firebaseUid, normalizedEmail);

      const existingProfileByEmail = await this.findProfileByFirebaseEmail(
        client,
        normalizedEmail
      );

      if (existingProfileByEmail !== undefined) {
        const linkedProfile = await this.linkFirebaseIdentity(
          client,
          existingProfileByEmail.id,
          identity,
          normalizedEmail
        );
        await client.query('commit');
        return {
          status: 'found',
          matchedBy: 'email',
          profile: linkedProfile
        };
      }

      const existingProfileByUid = await this.findProfileByFirebaseUid(
        client,
        identity.firebaseUid
      );

      if (existingProfileByUid !== undefined) {
        const linkedProfile = await this.linkFirebaseIdentity(
          client,
          existingProfileByUid.id,
          identity,
          normalizedEmail
        );
        await client.query('commit');
        return {
          status: 'found',
          matchedBy: 'firebase_uid',
          profile: linkedProfile
        };
      }

      if (identity.signupDisplayName === undefined) {
        await client.query('commit');
        return {
          status: 'signup_required'
        };
      }

      const profileId = randomUUID();
      const displayName = identity.signupDisplayName;

      await client.query(
        `
          insert into auth.users (
            id,
            aud,
            role,
            email,
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
            '{"provider":"google","providers":["google"]}'::jsonb,
            jsonb_build_object(
              'display_name', $3::text,
              'firebase_uid', $4::text,
              'avatar_url', $5::text
            ),
            now(),
            now()
          )
        `,
        [profileId, normalizedEmail, displayName, identity.firebaseUid, identity.avatarUrl ?? null]
      );

      const createdProfileResult = await client.query<ProfileRow>(
        `
          insert into profiles (
            id,
            phone,
            firebase_uid,
            email,
            display_name,
            avatar_url
          )
          values ($1, null, $2, $3, $4, $5)
          returning id, phone
        `,
        [
          profileId,
          identity.firebaseUid,
          normalizedEmail,
          displayName,
          identity.avatarUrl ?? null
        ]
      );
      const createdProfile = createdProfileResult.rows[0];

      if (createdProfile === undefined) {
        throw new Error('profile insert returned no row');
      }

      await client.query('commit');
      return {
        status: 'created',
        profile: createdProfile
      };
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

  private async findProfileByFirebaseEmail(
    client: PoolClient,
    email: string
  ): Promise<ProfileRow | undefined> {
    const result = await client.query<ProfileRow>(
      `
        select id, phone
        from profiles
        where lower(email) = $1
      `,
      [email]
    );

    return result.rows[0];
  }

  private async findProfileByFirebaseUid(
    client: PoolClient,
    firebaseUid: string
  ): Promise<ProfileRow | undefined> {
    const result = await client.query<ProfileRow>(
      `
        select id, phone
        from profiles
        where firebase_uid = $1
      `,
      [firebaseUid]
    );

    return result.rows[0];
  }

  private async linkFirebaseIdentity(
    client: PoolClient,
    profileId: string,
    identity: FirebaseProfileIdentity,
    normalizedEmail: string
  ): Promise<ProfileRow> {
    await client.query(
      `
        update auth.users
        set
          email = coalesce(email, $2),
          raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
            || '{"provider":"google","providers":["google"]}'::jsonb,
          raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
            || jsonb_strip_nulls(
              jsonb_build_object(
                'firebase_uid', $3::text,
                'avatar_url', $4::text
              )
            ),
          updated_at = now()
        where id = $1
      `,
      [profileId, normalizedEmail, identity.firebaseUid, identity.avatarUrl ?? null]
    );

    const result = await client.query<ProfileRow>(
      `
        update profiles
        set
          firebase_uid = coalesce(firebase_uid, $2),
          email = coalesce(email, $3),
          avatar_url = coalesce(avatar_url, $4),
          updated_at = now()
        where id = $1
        returning id, phone
      `,
      [profileId, identity.firebaseUid, normalizedEmail, identity.avatarUrl ?? null]
    );
    const linkedProfile = result.rows[0];

    if (linkedProfile === undefined) {
      throw new Error('profile link returned no row');
    }

    return linkedProfile;
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

function authEmail(profileId: string): string {
  return `${profileId}@phone.maidan.local`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function lockFirebaseIdentity(
  client: PoolClient,
  firebaseUid: string,
  email: string
): Promise<void> {
  const lockKeys = [`firebase_uid:${firebaseUid}`, `firebase_email:${email}`].sort();

  for (const lockKey of lockKeys) {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [lockKey]);
  }
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

  return new InternalServerErrorException('Failed to persist auth profile', { cause: error });
}
