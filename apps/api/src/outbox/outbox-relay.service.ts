import { Inject, Injectable } from '@nestjs/common';
import {
  QUEUE_EMBEDDINGS,
  QUEUE_MODERATION,
  QUEUE_NOTIFICATIONS,
  STREAM_DOMAIN_EVENTS
} from '@maidan/shared';
import type Redis from 'ioredis';

import { REDIS_CLIENT } from '../redis/redis.constants';
import { RedisInfrastructure } from '../redis/redis.infrastructure';
import { DEFAULT_OUTBOX_RELAY_BATCH_SIZE, OUTBOX_RELAY_REPOSITORY } from './outbox.constants';
import type {
  DomainEventEnvelope,
  DomainEventJobData,
  OutboxRelayRepository,
  OutboxRelayTickResult
} from './outbox.types';

type DerivedQueueName =
  | typeof QUEUE_EMBEDDINGS
  | typeof QUEUE_MODERATION
  | typeof QUEUE_NOTIFICATIONS;

interface DerivedJobRoute {
  queueName: DerivedQueueName;
}

@Injectable()
export class OutboxRelayService {
  constructor(
    @Inject(OUTBOX_RELAY_REPOSITORY)
    private readonly repository: OutboxRelayRepository,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
    private readonly redisInfrastructure: RedisInfrastructure
  ) {}

  async tick(batchSize = getOutboxRelayBatchSize()): Promise<OutboxRelayTickResult> {
    const streamEntries: string[] = [];
    let jobsEnqueued = 0;

    const processed = await this.repository.relayBatch(batchSize, async (event) => {
      const streamEntryId = await this.publishToStream(event);
      streamEntries.push(streamEntryId);

      const route = this.getDerivedJobRoute(event.event_type);

      if (route === undefined) {
        return;
      }

      const queue = this.redisInfrastructure.getQueue<DomainEventJobData>(route.queueName);

      await queue.add(
        event.event_type,
        {
          ...event,
          stream_entry_id: streamEntryId
        },
        {
          jobId: getDerivedJobId(event, route.queueName),
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 1_000
          },
          removeOnComplete: {
            age: 24 * 60 * 60,
            count: 1_000
          },
          removeOnFail: {
            age: 7 * 24 * 60 * 60
          }
        }
      );
      jobsEnqueued += 1;
    });

    return {
      processed,
      stream_entries: streamEntries,
      jobs_enqueued: jobsEnqueued
    };
  }

  private async publishToStream(event: DomainEventEnvelope): Promise<string> {
    const streamEntryId = await this.redis.xadd(
      STREAM_DOMAIN_EVENTS,
      '*',
      'id',
      String(event.id),
      'aggregate_type',
      event.aggregate_type,
      'aggregate_id',
      event.aggregate_id,
      'event_type',
      event.event_type,
      'payload',
      JSON.stringify(event.payload),
      'created_at',
      event.created_at
    );

    if (streamEntryId === null) {
      throw new Error(`Redis XADD did not return an entry id for domain_event ${event.id}`);
    }

    return streamEntryId;
  }

  private getDerivedJobRoute(eventType: string): DerivedJobRoute | undefined {
    switch (eventType) {
      case 'activity.published':
        return {
          queueName: QUEUE_EMBEDDINGS
        };
      case 'post.created':
      case 'message.created':
        return {
          queueName: QUEUE_MODERATION
        };
      case 'booking.confirmed':
        return {
          queueName: QUEUE_NOTIFICATIONS
        };
      default:
        return undefined;
    }
  }
}

function getOutboxRelayBatchSize(): number {
  return getPositiveIntegerEnv('OUTBOX_RELAY_BATCH_SIZE', DEFAULT_OUTBOX_RELAY_BATCH_SIZE);
}

function getDerivedJobId(event: DomainEventEnvelope, queueName: DerivedQueueName): string {
  const safeQueueName = queueName.replace(/[^a-zA-Z0-9_-]/g, '-');

  return `domain-event-${event.id}-${safeQueueName}`;
}

function getPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];

  if (rawValue === undefined || rawValue.length === 0) {
    return fallback;
  }

  const value = Number(rawValue);

  return Number.isInteger(value) && value > 0 ? value : fallback;
}
