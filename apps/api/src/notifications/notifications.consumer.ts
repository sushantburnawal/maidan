import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { QUEUE_NOTIFICATIONS } from '@maidan/shared';
import type { Worker } from 'bullmq';

import type { DomainEventJobData } from '../outbox/outbox.types';
import { RedisInfrastructure } from '../redis/redis.infrastructure';
import {
  NotificationsService,
  type NotificationDispatchResult
} from './notifications.service';

@Injectable()
export class NotificationsConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsConsumer.name);
  private worker: Worker<DomainEventJobData, NotificationDispatchResult> | undefined;

  constructor(
    private readonly redisInfrastructure: RedisInfrastructure,
    private readonly notificationsService: NotificationsService
  ) {}

  onApplicationBootstrap(): void {
    if (isNotificationsWorkerDisabled()) {
      return;
    }

    this.worker = this.redisInfrastructure.createWorker<
      DomainEventJobData,
      NotificationDispatchResult
    >(QUEUE_NOTIFICATIONS, async (job) => this.handleJob(job.data));
    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `Notification job failed id=${job?.id ?? 'unknown'}`,
        error instanceof Error ? error.stack : String(error)
      );
    });
  }

  async handleJob(jobData: DomainEventJobData): Promise<NotificationDispatchResult> {
    return this.notificationsService.consume(jobData);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker !== undefined) {
      await this.worker.close();
    }
  }
}

function isNotificationsWorkerDisabled(): boolean {
  if (process.env.NOTIFICATIONS_WORKER_DISABLED === 'true') {
    return true;
  }

  return process.env.NODE_ENV === 'test' && process.env.NOTIFICATIONS_WORKER_DISABLED !== 'false';
}
