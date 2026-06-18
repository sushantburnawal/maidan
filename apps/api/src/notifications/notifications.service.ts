import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  bookingCancelledPayloadSchema,
  bookingConfirmedPayloadSchema,
  messageCreatedPayloadSchema,
  paymentFailedPayloadSchema
} from '@maidan/shared';

import type { DomainEventJobData } from '../outbox/outbox.types';
import {
  NOTIFICATIONS_PRESENCE_CHECKER,
  NOTIFICATIONS_REPOSITORY,
  PUSH_PROVIDER
} from './notifications.constants';
import type { RegisterDeviceDto } from './dto/register-device.dto';
import type {
  NotificationDeviceRecord,
  NotificationsRepository,
  PresenceChecker,
  PushMessage,
  PushNotification,
  PushProvider
} from './notifications.types';

interface NotificationPlan {
  recipientIds: string[];
  notification: PushNotification;
  data: Record<string, string>;
  offlineOnly: boolean;
}

export interface NotificationDispatchResult {
  recipients_considered: number;
  pushes_sent: number;
  skipped_muted: number;
  skipped_online: number;
  skipped_without_devices: number;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @Inject(NOTIFICATIONS_REPOSITORY)
    private readonly repository: NotificationsRepository,
    @Inject(PUSH_PROVIDER)
    private readonly pushProvider: PushProvider,
    @Inject(NOTIFICATIONS_PRESENCE_CHECKER)
    private readonly presenceChecker: PresenceChecker
  ) {}

  async registerDevice(
    profileId: string,
    dto: RegisterDeviceDto
  ): Promise<NotificationDeviceRecord> {
    return this.repository.upsertDevice(profileId, {
      token: dto.token
    });
  }

  async consume(job: DomainEventJobData): Promise<NotificationDispatchResult> {
    const plan = await this.toNotificationPlan(job);

    if (plan === undefined) {
      return emptyDispatchResult();
    }

    const result = emptyDispatchResult();

    for (const recipientId of uniqueProfileIds(plan.recipientIds)) {
      result.recipients_considered += 1;

      if (plan.offlineOnly && (await this.presenceChecker.isOnline(recipientId))) {
        result.skipped_online += 1;
        continue;
      }

      const target = await this.repository.findPushTarget(recipientId);

      if (target === undefined || target.device_tokens.length === 0) {
        result.skipped_without_devices += 1;
        continue;
      }

      if (target.push_muted) {
        result.skipped_muted += 1;
        continue;
      }

      for (const token of target.device_tokens) {
        await this.pushProvider.send(toPushMessage(token, plan));
        result.pushes_sent += 1;
      }
    }

    return result;
  }

  private async toNotificationPlan(job: DomainEventJobData): Promise<NotificationPlan | undefined> {
    switch (job.event_type) {
      case 'booking.confirmed':
        return this.bookingConfirmedPlan(job);
      case 'booking.cancelled':
        return this.bookingCancelledPlan(job);
      case 'payment.failed':
        return this.paymentFailedPlan(job);
      case 'message.created':
        return this.messageCreatedPlan(job);
      default:
        return undefined;
    }
  }

  private async bookingConfirmedPlan(
    job: DomainEventJobData
  ): Promise<NotificationPlan | undefined> {
    const parsed = bookingConfirmedPayloadSchema.safeParse(job.payload);

    if (!parsed.success) {
      this.logger.warn(`Ignored invalid booking.confirmed notification event=${job.id}`);
      return undefined;
    }

    return {
      recipientIds: [parsed.data.explorer_id, parsed.data.host_id],
      notification: {
        title: "You're in!",
        body: "You're in! Your Maidan booking is confirmed."
      },
      data: compactData({
        event_type: job.event_type,
        domain_event_id: String(job.id),
        booking_id: parsed.data.booking_id,
        activity_id: parsed.data.activity_id,
        slot_id: parsed.data.slot_id
      }),
      offlineOnly: false
    };
  }

  private async bookingCancelledPlan(
    job: DomainEventJobData
  ): Promise<NotificationPlan | undefined> {
    const parsed = bookingCancelledPayloadSchema.safeParse(job.payload);

    if (!parsed.success) {
      this.logger.warn(`Ignored invalid booking.cancelled notification event=${job.id}`);
      return undefined;
    }

    return {
      recipientIds: [parsed.data.explorer_id, parsed.data.host_id],
      notification: {
        title: 'Booking cancelled',
        body: 'Your Maidan booking has been cancelled.'
      },
      data: compactData({
        event_type: job.event_type,
        domain_event_id: String(job.id),
        booking_id: parsed.data.booking_id,
        activity_id: parsed.data.activity_id,
        slot_id: parsed.data.slot_id
      }),
      offlineOnly: false
    };
  }

  private async paymentFailedPlan(job: DomainEventJobData): Promise<NotificationPlan | undefined> {
    const parsed = paymentFailedPayloadSchema.safeParse(job.payload);

    if (!parsed.success) {
      this.logger.warn(`Ignored invalid payment.failed notification event=${job.id}`);
      return undefined;
    }

    const explorerId = await this.repository.findBookingExplorerId(parsed.data.booking_id);

    if (explorerId === undefined) {
      return undefined;
    }

    return {
      recipientIds: [explorerId],
      notification: {
        title: 'Payment failed',
        body: "Your payment didn't go through. Please try again."
      },
      data: compactData({
        event_type: job.event_type,
        domain_event_id: String(job.id),
        booking_id: parsed.data.booking_id,
        payment_id: parsed.data.payment_id
      }),
      offlineOnly: false
    };
  }

  private async messageCreatedPlan(job: DomainEventJobData): Promise<NotificationPlan | undefined> {
    const parsed = messageCreatedPayloadSchema.safeParse(job.payload);

    if (!parsed.success) {
      this.logger.warn(`Ignored invalid message.created notification event=${job.id}`);
      return undefined;
    }

    const recipientIds = await this.repository.findChatRecipientIds(
      parsed.data.chat_id,
      parsed.data.sender_id
    );

    return {
      recipientIds,
      notification: {
        title: 'New message',
        body: parsed.data.body
      },
      data: compactData({
        event_type: job.event_type,
        domain_event_id: String(job.id),
        message_id: parsed.data.message_id,
        chat_id: parsed.data.chat_id,
        activity_id: parsed.data.activity_id
      }),
      offlineOnly: true
    };
  }
}

function toPushMessage(token: string, plan: NotificationPlan): PushMessage {
  return {
    token,
    notification: plan.notification,
    data: plan.data
  };
}

function compactData(input: Record<string, string | null | undefined>): Record<string, string> {
  const output: Record<string, string> = {};

  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.length > 0) {
      output[key] = value;
    }
  }

  return output;
}

function emptyDispatchResult(): NotificationDispatchResult {
  return {
    recipients_considered: 0,
    pushes_sent: 0,
    skipped_muted: 0,
    skipped_online: 0,
    skipped_without_devices: 0
  };
}

function uniqueProfileIds(profileIds: string[]): string[] {
  return Array.from(new Set(profileIds));
}
