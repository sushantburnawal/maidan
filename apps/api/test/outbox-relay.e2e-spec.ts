import { Test, type TestingModule } from '@nestjs/testing';
import { QUEUE_MODERATION, STREAM_DOMAIN_EVENTS } from '@maidan/shared';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

import type { DomainEventJobData } from '../src/outbox/outbox.types';
import { OutboxModule } from '../src/outbox/outbox.module';
import { OutboxRelayService } from '../src/outbox/outbox-relay.service';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { RedisInfrastructure } from '../src/redis/redis.infrastructure';

describe('Outbox relay integration', () => {
  let moduleRef: TestingModule;
  let relay: OutboxRelayService;
  let pool: Pool;
  let redis: Redis;
  let moderationQueue: Queue<DomainEventJobData>;

  let insertedEventId: number | undefined;
  let streamEntryId: string | undefined;
  let jobId: string | undefined;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalRedisUrl = process.env.REDIS_URL;
  const originalBullmqPrefix = process.env.BULLMQ_PREFIX;
  const originalOutboxRelayEnabled = process.env.OUTBOX_RELAY_ENABLED;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
    process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
    process.env.BULLMQ_PREFIX = `maidan-test-${randomUUID()}`;
    process.env.OUTBOX_RELAY_ENABLED = 'false';

    moduleRef = await Test.createTestingModule({
      imports: [OutboxModule]
    }).compile();

    relay = moduleRef.get(OutboxRelayService);
    redis = moduleRef.get<Redis>(REDIS_CLIENT);
    moderationQueue = moduleRef
      .get(RedisInfrastructure)
      .getQueue<DomainEventJobData>(QUEUE_MODERATION);
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : undefined
    });

    await pool.query('select 1');
    await redis.ping();
    await moderationQueue.waitUntilReady();
  });

  afterEach(async () => {
    if (jobId !== undefined) {
      const job = await moderationQueue.getJob(jobId);
      await job?.remove();
      jobId = undefined;
    }

    if (streamEntryId !== undefined) {
      await redis.xdel(STREAM_DOMAIN_EVENTS, streamEntryId);
      streamEntryId = undefined;
    }

    if (insertedEventId !== undefined) {
      await pool.query('delete from domain_events where id = $1::bigint', [insertedEventId]);
      insertedEventId = undefined;
    }
  });

  afterAll(async () => {
    await pool?.end();
    await moduleRef?.close();
    restoreEnv('DATABASE_URL', originalDatabaseUrl);
    restoreEnv('REDIS_URL', originalRedisUrl);
    restoreEnv('BULLMQ_PREFIX', originalBullmqPrefix);
    restoreEnv('OUTBOX_RELAY_ENABLED', originalOutboxRelayEnabled);
  });

  it('publishes unprocessed domain events to Redis Streams and derived BullMQ jobs once', async () => {
    const postId = randomUUID();
    const authorId = randomUUID();
    const createdAt = new Date().toISOString();
    const payload = {
      post_id: postId,
      author_id: authorId,
      linked_activity_id: null,
      body: 'Relay this post for moderation',
      media_count: 0,
      created_at: createdAt
    };

    const insertResult = await pool.query<{ id: string }>(
      `
        insert into domain_events (aggregate_type, aggregate_id, event_type, payload)
        values ('post', $1::uuid, 'post.created', $2::jsonb)
        returning id::text
      `,
      [postId, JSON.stringify(payload)]
    );
    const insertedId = insertResult.rows[0]?.id;

    if (insertedId === undefined) {
      throw new Error('domain_events insert did not return an id');
    }

    insertedEventId = Number(insertedId);
    jobId = `domain-event-${insertedEventId}-${QUEUE_MODERATION.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

    const firstTick = await relay.tick(10);

    expect(firstTick).toEqual({
      processed: 1,
      stream_entries: [expect.any(String)],
      jobs_enqueued: 1
    });
    const firstStreamEntryId = firstTick.stream_entries[0];

    if (firstStreamEntryId === undefined) {
      throw new Error('Relay tick did not return a stream entry id');
    }

    streamEntryId = firstStreamEntryId;

    const streamEntries = await redis.xrange(STREAM_DOMAIN_EVENTS, streamEntryId, streamEntryId);
    expect(streamEntries).toHaveLength(1);
    const streamFields = toStreamFields(streamEntries[0]?.[1] ?? []);
    expect(streamFields).toMatchObject({
      id: String(insertedEventId),
      aggregate_type: 'post',
      aggregate_id: postId,
      event_type: 'post.created'
    });
    expect(JSON.parse(streamFields.payload ?? '{}')).toEqual(payload);

    const job = await moderationQueue.getJob(jobId);
    expect(job).toBeDefined();
    expect(job?.name).toBe('post.created');
    expect(job?.data).toMatchObject({
      id: insertedEventId,
      aggregate_type: 'post',
      aggregate_id: postId,
      event_type: 'post.created',
      payload,
      stream_entry_id: streamEntryId
    });

    const processedResult = await pool.query<{ processed_at: Date | null }>(
      'select processed_at from domain_events where id = $1::bigint',
      [insertedEventId]
    );
    expect(processedResult.rows[0]?.processed_at).toBeInstanceOf(Date);

    await expect(relay.tick(10)).resolves.toEqual({
      processed: 0,
      stream_entries: [],
      jobs_enqueued: 0
    });
  });
});

function toStreamFields(values: string[]): Record<string, string> {
  const fields: Record<string, string> = {};

  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];

    if (key !== undefined && value !== undefined) {
      fields[key] = value;
    }
  }

  return fields;
}

function restoreEnv(name: string, originalValue: string | undefined): void {
  if (originalValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = originalValue;
  }
}
