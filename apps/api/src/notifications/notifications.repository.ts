import { Injectable, InternalServerErrorException, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import type {
  NotificationDeviceRecord,
  NotificationsRepository,
  PushTarget,
  RegisterDeviceInput
} from './notifications.types';

interface NotificationDeviceRow {
  id: string;
  profile_id: string;
  token: string;
  created_at: Date | string;
  updated_at: Date | string;
  last_seen_at: Date | string;
}

interface PushTargetRow {
  profile_id: string;
  push_muted: boolean | null;
  device_tokens: string[] | null;
}

@Injectable()
export class PostgresNotificationsRepository
  implements NotificationsRepository, OnModuleDestroy
{
  private pool: Pool | undefined;

  async upsertDevice(
    profileId: string,
    input: RegisterDeviceInput
  ): Promise<NotificationDeviceRecord> {
    try {
      const result = await this.getPool().query<NotificationDeviceRow>(
        `
          insert into notification_devices (profile_id, token)
          values ($1, $2)
          on conflict (token) do update
          set
            profile_id = excluded.profile_id,
            last_seen_at = now(),
            updated_at = now()
          returning ${deviceColumns()}
        `,
        [profileId, input.token]
      );
      const device = mapDevice(result.rows[0]);

      if (device === undefined) {
        throw new InternalServerErrorException('Notification device row was not returned');
      }

      return device;
    } catch (error) {
      throw toRepositoryError(error, 'Failed to store notification device');
    }
  }

  async findPushTarget(profileId: string): Promise<PushTarget | undefined> {
    try {
      const result = await this.getPool().query<PushTargetRow>(
        `
          select
            p.id as profile_id,
            ns.push_muted,
            coalesce(
              array_agg(nd.token order by nd.updated_at desc)
                filter (where nd.token is not null),
              '{}'::text[]
            ) as device_tokens
          from profiles p
          left join notification_settings ns on ns.profile_id = p.id
          left join notification_devices nd on nd.profile_id = p.id
          where p.id = $1
          group by p.id, ns.push_muted
        `,
        [profileId]
      );

      return mapPushTarget(result.rows[0]);
    } catch (error) {
      throw toRepositoryError(error, 'Failed to read notification target');
    }
  }

  async findBookingExplorerId(bookingId: string): Promise<string | undefined> {
    try {
      const result = await this.getPool().query<{ explorer_id: string }>(
        `
          select explorer_id
          from bookings
          where id = $1
        `,
        [bookingId]
      );

      return result.rows[0]?.explorer_id;
    } catch (error) {
      throw toRepositoryError(error, 'Failed to read booking explorer');
    }
  }

  async findChatRecipientIds(chatId: string, senderId: string): Promise<string[]> {
    try {
      const result = await this.getPool().query<{ profile_id: string }>(
        `
          select profile_id
          from chat_members
          where chat_id = $1
            and profile_id <> $2
          order by joined_at asc
        `,
        [chatId, senderId]
      );

      return result.rows.map((row) => row.profile_id);
    } catch (error) {
      throw toRepositoryError(error, 'Failed to read chat recipients');
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

function deviceColumns(alias?: string): string {
  const prefix = alias === undefined ? '' : `${alias}.`;

  return `
    ${prefix}id,
    ${prefix}profile_id,
    ${prefix}token,
    ${prefix}created_at,
    ${prefix}updated_at,
    ${prefix}last_seen_at
  `;
}

function mapDevice(row: NotificationDeviceRow | undefined): NotificationDeviceRecord | undefined {
  if (row === undefined) {
    return undefined;
  }

  return {
    id: row.id,
    profile_id: row.profile_id,
    token: row.token,
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
    last_seen_at: toIsoTimestamp(row.last_seen_at)
  };
}

function mapPushTarget(row: PushTargetRow | undefined): PushTarget | undefined {
  if (row === undefined) {
    return undefined;
  }

  return {
    profile_id: row.profile_id,
    push_muted: row.push_muted === true,
    device_tokens: row.device_tokens ?? []
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
