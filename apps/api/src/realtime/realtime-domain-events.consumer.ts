import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { STREAM_DOMAIN_EVENTS } from '@maidan/shared';
import type Redis from 'ioredis';

import type { DomainEventEnvelope } from '../outbox/outbox.types';
import { RedisInfrastructure } from '../redis/redis.infrastructure';
import { REALTIME_LAST_EVENT_ID_KEY } from './realtime.constants';
import { RealtimeGateway } from './realtime.gateway';

type XReadResponse = Array<[string, Array<[string, string[]]>]>;

@Injectable()
export class RealtimeDomainEventsConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeDomainEventsConsumer.name);
  private redis: Redis | undefined;
  private running = false;

  constructor(
    private readonly redisInfrastructure: RedisInfrastructure,
    private readonly realtimeGateway: RealtimeGateway
  ) {}

  onApplicationBootstrap(): void {
    if (isStreamConsumerDisabled()) {
      return;
    }

    this.redis = this.redisInfrastructure.client.duplicate();
    this.redis.on('error', (error) => {
      this.logger.error(
        'Realtime Redis stream client error',
        error instanceof Error ? error.stack : String(error)
      );
    });
    this.running = true;
    void this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;

    if (this.redis === undefined || this.redis.status === 'end') {
      return;
    }

    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }

  private async run(): Promise<void> {
    const redis = this.redis;

    if (redis === undefined) {
      return;
    }

    let lastId = await this.getInitialLastId(redis);

    while (this.running) {
      try {
        const response = (await redis.call(
          'XREAD',
          'BLOCK',
          '5000',
          'COUNT',
          '25',
          'STREAMS',
          STREAM_DOMAIN_EVENTS,
          lastId
        )) as XReadResponse | null;

        if (response === null) {
          continue;
        }

        for (const [, entries] of response) {
          for (const [entryId, fields] of entries) {
            const event = streamFieldsToDomainEvent(fields);

            if (event !== undefined) {
              await this.realtimeGateway.publishDomainEvent(event);
            }

            lastId = entryId;
            await redis.set(REALTIME_LAST_EVENT_ID_KEY, lastId);
          }
        }
      } catch (error) {
        if (!this.running) {
          return;
        }

        this.logger.error(
          'Realtime Redis stream consumer error',
          error instanceof Error ? error.stack : String(error)
        );
        await delay(1000);
      }
    }
  }

  private async getInitialLastId(redis: Redis): Promise<string> {
    const storedLastId = await redis.get(REALTIME_LAST_EVENT_ID_KEY);

    if (storedLastId !== null && storedLastId.length > 0) {
      return storedLastId;
    }

    return process.env.REALTIME_STREAM_START_ID ?? '0-0';
  }
}

function streamFieldsToDomainEvent(fields: string[]): DomainEventEnvelope | undefined {
  const values = new Map<string, string>();

  for (let index = 0; index < fields.length; index += 2) {
    const key = fields[index];
    const value = fields[index + 1];

    if (key !== undefined && value !== undefined) {
      values.set(key, value);
    }
  }

  const id = Number(values.get('id'));
  const aggregateType = values.get('aggregate_type');
  const aggregateId = values.get('aggregate_id');
  const eventType = values.get('event_type');
  const payloadRaw = values.get('payload');
  const createdAt = values.get('created_at');

  if (
    !Number.isInteger(id) ||
    aggregateType === undefined ||
    aggregateId === undefined ||
    eventType === undefined ||
    payloadRaw === undefined ||
    createdAt === undefined
  ) {
    return undefined;
  }

  try {
    const payload = JSON.parse(payloadRaw) as unknown;

    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return undefined;
    }

    return {
      id,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      event_type: eventType,
      payload: payload as Record<string, unknown>,
      created_at: createdAt
    };
  } catch {
    return undefined;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isStreamConsumerDisabled(): boolean {
  if (process.env.REALTIME_STREAM_CONSUMER_DISABLED === 'true') {
    return true;
  }

  return (
    process.env.NODE_ENV === 'test' && process.env.REALTIME_STREAM_CONSUMER_DISABLED !== 'false'
  );
}
