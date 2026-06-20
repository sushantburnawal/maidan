import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { QUEUE_EMBEDDINGS, QUEUE_MODERATION, QUEUE_NOTIFICATIONS } from '@maidan/shared';
import { Queue, Worker, type Processor, type QueueOptions, type WorkerOptions } from 'bullmq';
import Redis, { type RedisOptions } from 'ioredis';

const BULLMQ_QUEUE_NAMES = [QUEUE_EMBEDDINGS, QUEUE_MODERATION, QUEUE_NOTIFICATIONS] as const;

type BullMqQueueName = (typeof BULLMQ_QUEUE_NAMES)[number];

export interface QueueDepthMetric {
  active: number;
  delayed: number;
  failed: number;
  paused: number;
  waiting: number;
}

@Injectable()
export class RedisInfrastructure implements OnModuleDestroy {
  private readonly logger = new Logger(RedisInfrastructure.name);
  private readonly redisUrl: string;
  readonly client: Redis;
  private readonly queues = new Map<BullMqQueueName, Queue<unknown>>();

  constructor() {
    this.redisUrl = getRedisUrl();

    this.client = new Redis(this.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1
    });
    this.client.on('error', (error) => {
      this.logger.error('Redis client error', error instanceof Error ? error.stack : String(error));
    });
  }

  getQueue<DataType = unknown>(queueName: BullMqQueueName): Queue<DataType> {
    const existingQueue = this.queues.get(queueName);

    if (existingQueue !== undefined) {
      return existingQueue as unknown as Queue<DataType>;
    }

    const queue = new Queue<unknown>(queueName, createQueueOptions(this.redisUrl));
    queue.on('error', (error) => {
      this.logger.error(
        `BullMQ queue error queue=${queueName}`,
        error instanceof Error ? error.stack : String(error)
      );
    });
    this.queues.set(queueName, queue);

    return queue as unknown as Queue<DataType>;
  }

  createWorker<DataType = unknown, ResultType = unknown>(
    queueName: BullMqQueueName,
    processor: Processor<DataType, ResultType>
  ): Worker<DataType, ResultType> {
    const worker = new Worker<DataType, ResultType>(
      queueName,
      processor,
      createWorkerOptions(this.redisUrl)
    );

    worker.on('error', (error) => {
      this.logger.error(
        `BullMQ worker error queue=${queueName}`,
        error instanceof Error ? error.stack : String(error)
      );
    });

    return worker;
  }

  async getQueueDepths(): Promise<Record<BullMqQueueName, QueueDepthMetric>> {
    const entries = await Promise.all(
      BULLMQ_QUEUE_NAMES.map(async (queueName) => {
        const queue = this.getQueue(queueName);
        const counts = await queue.getJobCounts('active', 'delayed', 'failed', 'paused', 'waiting');

        return [
          queueName,
          {
            active: counts.active ?? 0,
            delayed: counts.delayed ?? 0,
            failed: counts.failed ?? 0,
            paused: counts.paused ?? 0,
            waiting: counts.waiting ?? 0
          }
        ] as const;
      })
    );

    return Object.fromEntries(entries) as Record<BullMqQueueName, QueueDepthMetric>;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(Array.from(this.queues.values(), (queue) => queue.close()));

    if (this.client.status === 'end') {
      return;
    }

    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}

function createQueueOptions(redisUrl: string): QueueOptions {
  return {
    connection: parseRedisUrl(redisUrl),
    prefix: process.env.BULLMQ_PREFIX ?? 'maidan',
    skipWaitingForReady: true
  };
}

function createWorkerOptions(redisUrl: string): WorkerOptions {
  return {
    connection: parseRedisUrl(redisUrl),
    prefix: process.env.BULLMQ_PREFIX ?? 'maidan',
    skipWaitingForReady: true
  };
}

function getRedisUrl(): string {
  if (process.env.REDIS_URL !== undefined && process.env.REDIS_URL.length > 0) {
    return process.env.REDIS_URL;
  }

  const host = process.env.REDIS_HOST ?? 'localhost';
  const port = process.env.REDIS_PORT ?? '6379';

  return `redis://${host}:${port}`;
}

function parseRedisUrl(redisUrl: string): RedisOptions {
  const parsedUrl = new URL(redisUrl);
  const dbFromPath =
    parsedUrl.pathname.length > 1 ? Number(parsedUrl.pathname.slice(1)) : undefined;

  return {
    host: parsedUrl.hostname,
    port: parsedUrl.port.length > 0 ? Number(parsedUrl.port) : 6379,
    username: parsedUrl.username.length > 0 ? decodeURIComponent(parsedUrl.username) : undefined,
    password: parsedUrl.password.length > 0 ? decodeURIComponent(parsedUrl.password) : undefined,
    db: Number.isInteger(dbFromPath) ? dbFromPath : undefined,
    tls: parsedUrl.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null
  };
}
