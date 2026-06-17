import { InternalServerErrorException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import type {
  DomainEventEnvelope,
  OutboxHealthMetric,
  OutboxRelayRepository
} from './outbox.types';

interface DomainEventRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date | string;
}

interface OutboxHealthRow {
  unprocessed_count: string | number;
  oldest_unprocessed_age_seconds: string | number | null;
}

@Injectable()
export class PostgresOutboxRelayRepository implements OutboxRelayRepository, OnModuleDestroy {
  private pool: Pool | undefined;

  async relayBatch(
    batchSize: number,
    dispatch: (event: DomainEventEnvelope) => Promise<void>
  ): Promise<number> {
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error('Outbox relay batch size must be a positive integer');
    }

    const client = await this.getPool().connect();
    let processed = 0;

    try {
      await client.query('begin');

      const eventsResult = await client.query<DomainEventRow>(
        `
          select
            id::text,
            aggregate_type,
            aggregate_id::text,
            event_type,
            payload,
            created_at
          from domain_events
          where processed_at is null
          order by id
          limit $1
          for update skip locked
        `,
        [batchSize]
      );

      for (const row of eventsResult.rows) {
        const event = mapDomainEvent(row);

        await dispatch(event);
        await client.query(
          `
            update domain_events
            set processed_at = now()
            where id = $1::bigint
          `,
          [row.id]
        );
        processed += 1;
      }

      await client.query('commit');

      return processed;
    } catch (error) {
      try {
        await client.query('rollback');
      } catch {
        // Preserve the original relay failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getHealth(): Promise<OutboxHealthMetric> {
    const result = await this.getPool().query<OutboxHealthRow>(
      `
        select
          count(*) as unprocessed_count,
          extract(epoch from now() - min(created_at)) as oldest_unprocessed_age_seconds
        from domain_events
        where processed_at is null
      `
    );
    const row = result.rows[0];

    return {
      unprocessed_count: Number(row?.unprocessed_count ?? 0),
      oldest_unprocessed_age_seconds:
        row?.oldest_unprocessed_age_seconds === null ||
        row?.oldest_unprocessed_age_seconds === undefined
          ? null
          : Number(row.oldest_unprocessed_age_seconds)
    };
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

function mapDomainEvent(row: DomainEventRow): DomainEventEnvelope {
  const id = Number(row.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error(`Invalid domain event id: ${row.id}`);
  }

  return {
    id,
    aggregate_type: row.aggregate_type,
    aggregate_id: row.aggregate_id,
    event_type: row.event_type,
    payload: row.payload,
    created_at: toIsoTimestamp(row.created_at)
  };
}

function toIsoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
