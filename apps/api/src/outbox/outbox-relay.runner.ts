import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';

import {
  DEFAULT_OUTBOX_RELAY_INTERVAL_MS,
  DEFAULT_OUTBOX_RELAY_BATCH_SIZE
} from './outbox.constants';
import { OutboxRelayService } from './outbox-relay.service';

@Injectable()
export class OutboxRelayRunner implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayRunner.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly relay: OutboxRelayService) {}

  onApplicationBootstrap(): void {
    if (!isOutboxRelayEnabled()) {
      return;
    }

    const intervalMs = getPositiveIntegerEnv(
      'OUTBOX_RELAY_INTERVAL_MS',
      DEFAULT_OUTBOX_RELAY_INTERVAL_MS
    );

    this.timer = setInterval(() => {
      void this.runTick();
    }, intervalMs);
    this.timer.unref();
    this.logger.log(
      `Outbox relay started with interval_ms=${intervalMs} batch_size=${getPositiveIntegerEnv(
        'OUTBOX_RELAY_BATCH_SIZE',
        DEFAULT_OUTBOX_RELAY_BATCH_SIZE
      )}`
    );
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async runTick(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      const result = await this.relay.tick();

      if (result.processed > 0) {
        this.logger.debug(
          `Outbox relay processed=${result.processed} jobs_enqueued=${result.jobs_enqueued}`
        );
      }
    } catch (error) {
      this.logger.error(
        'Outbox relay tick failed',
        error instanceof Error ? error.stack : String(error)
      );
    } finally {
      this.running = false;
    }
  }
}

function isOutboxRelayEnabled(): boolean {
  if (process.env.NODE_ENV === 'test') {
    return process.env.OUTBOX_RELAY_ENABLED === 'true';
  }

  return process.env.OUTBOX_RELAY_ENABLED !== 'false';
}

function getPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];

  if (rawValue === undefined || rawValue.length === 0) {
    return fallback;
  }

  const value = Number(rawValue);

  return Number.isInteger(value) && value > 0 ? value : fallback;
}
