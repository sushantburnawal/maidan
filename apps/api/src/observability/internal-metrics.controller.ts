import { Controller, Get, Inject } from '@nestjs/common';

import { OUTBOX_RELAY_REPOSITORY } from '../outbox/outbox.constants';
import type { OutboxHealthMetric, OutboxRelayRepository } from '../outbox/outbox.types';
import { RedisInfrastructure, type QueueDepthMetric } from '../redis/redis.infrastructure';
import { RealtimeGateway } from '../realtime/realtime.gateway';

interface ApiMetricsResponse {
  service: 'api';
  generated_at: string;
  outbox: OutboxHealthMetric | null;
  queues: Record<string, QueueDepthMetric> | null;
  websocket: {
    connection_count: number;
  };
}

@Controller('internal/metrics')
export class InternalMetricsController {
  constructor(
    @Inject(OUTBOX_RELAY_REPOSITORY)
    private readonly outboxRepository: OutboxRelayRepository,
    private readonly redisInfrastructure: RedisInfrastructure,
    private readonly realtimeGateway: RealtimeGateway
  ) {}

  @Get()
  async getMetrics(): Promise<ApiMetricsResponse> {
    const [outbox, queues] = await Promise.all([
      nullableMetric(() => this.outboxRepository.getHealth()),
      nullableMetric(() => this.redisInfrastructure.getQueueDepths())
    ]);

    return {
      service: 'api',
      generated_at: new Date().toISOString(),
      outbox,
      queues,
      websocket: {
        connection_count: this.realtimeGateway.getConnectionCount()
      }
    };
  }
}

async function nullableMetric<T>(readMetric: () => Promise<T>): Promise<T | null> {
  try {
    return await readMetric();
  } catch {
    return null;
  }
}
