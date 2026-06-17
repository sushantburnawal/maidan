import { Controller, Get, Inject } from '@nestjs/common';

import { OUTBOX_RELAY_REPOSITORY } from './outbox.constants';
import type { OutboxHealthMetric, OutboxRelayRepository } from './outbox.types';

@Controller('internal/outbox')
export class OutboxHealthController {
  constructor(
    @Inject(OUTBOX_RELAY_REPOSITORY)
    private readonly repository: OutboxRelayRepository
  ) {}

  @Get('health')
  getHealth(): Promise<OutboxHealthMetric> {
    return this.repository.getHealth();
  }
}
