import { UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import { AuthService } from '../src/auth/auth.service';
import type { AuthenticatedUser } from '../src/auth/auth.types';
import { FakePushProvider } from '../src/notifications/fake-push.provider';
import {
  NOTIFICATIONS_PRESENCE_CHECKER,
  NOTIFICATIONS_REPOSITORY,
  PUSH_PROVIDER
} from '../src/notifications/notifications.constants';
import { NotificationsConsumer } from '../src/notifications/notifications.consumer';
import { NotificationsModule } from '../src/notifications/notifications.module';
import type {
  NotificationDeviceRecord,
  NotificationsRepository,
  PresenceChecker,
  PushTarget,
  RegisterDeviceInput
} from '../src/notifications/notifications.types';
import type { DomainEventJobData } from '../src/outbox/outbox.types';

class FakeAuthService {
  constructor(private readonly profileIdsByToken: ReadonlyMap<string, string>) {}

  authenticateAccessToken(accessToken: string): AuthenticatedUser {
    const profileId = this.profileIdsByToken.get(accessToken);

    if (profileId === undefined) {
      throw new UnauthorizedException('Invalid access token');
    }

    return { profileId };
  }
}

class FakeNotificationsRepository implements NotificationsRepository {
  private readonly deviceTokensByProfileId = new Map<string, string[]>();
  private readonly mutedProfileIds = new Set<string>();
  private readonly bookingExplorerByBookingId = new Map<string, string>();
  private readonly chatRecipientsByChatId = new Map<string, string[]>();

  reset(): void {
    this.deviceTokensByProfileId.clear();
    this.mutedProfileIds.clear();
    this.bookingExplorerByBookingId.clear();
    this.chatRecipientsByChatId.clear();
  }

  addDevice(profileId: string, token: string): void {
    const tokens = this.deviceTokensByProfileId.get(profileId) ?? [];

    if (!tokens.includes(token)) {
      tokens.push(token);
    }

    this.deviceTokensByProfileId.set(profileId, tokens);
  }

  getDeviceTokens(profileId: string): string[] {
    return [...(this.deviceTokensByProfileId.get(profileId) ?? [])];
  }

  setMuted(profileId: string, muted: boolean): void {
    if (muted) {
      this.mutedProfileIds.add(profileId);
      return;
    }

    this.mutedProfileIds.delete(profileId);
  }

  setBookingExplorer(bookingId: string, explorerId: string): void {
    this.bookingExplorerByBookingId.set(bookingId, explorerId);
  }

  setChatRecipients(chatId: string, recipientIds: string[]): void {
    this.chatRecipientsByChatId.set(chatId, [...recipientIds]);
  }

  async upsertDevice(
    profileId: string,
    input: RegisterDeviceInput
  ): Promise<NotificationDeviceRecord> {
    this.addDevice(profileId, input.token);

    return {
      id: randomUUID(),
      profile_id: profileId,
      token: input.token,
      created_at: '2026-06-17T08:00:00.000Z',
      updated_at: '2026-06-17T08:00:00.000Z',
      last_seen_at: '2026-06-17T08:00:00.000Z'
    };
  }

  async findPushTarget(profileId: string): Promise<PushTarget | undefined> {
    return {
      profile_id: profileId,
      push_muted: this.mutedProfileIds.has(profileId),
      device_tokens: this.getDeviceTokens(profileId)
    };
  }

  async findBookingExplorerId(bookingId: string): Promise<string | undefined> {
    return this.bookingExplorerByBookingId.get(bookingId);
  }

  async findChatRecipientIds(chatId: string, senderId: string): Promise<string[]> {
    return (this.chatRecipientsByChatId.get(chatId) ?? []).filter(
      (profileId) => profileId !== senderId
    );
  }
}

class FakePresenceChecker implements PresenceChecker {
  private readonly onlineProfileIds = new Set<string>();

  reset(): void {
    this.onlineProfileIds.clear();
  }

  setOnline(profileId: string, online: boolean): void {
    if (online) {
      this.onlineProfileIds.add(profileId);
      return;
    }

    this.onlineProfileIds.delete(profileId);
  }

  async isOnline(profileId: string): Promise<boolean> {
    return this.onlineProfileIds.has(profileId);
  }
}

describe('Notifications module', () => {
  let app: NestFastifyApplication;
  let consumer: NotificationsConsumer;
  let repository: FakeNotificationsRepository;
  let presenceChecker: FakePresenceChecker;
  let pushProvider: FakePushProvider;

  const profileId = randomUUID();
  const explorerId = randomUUID();
  const hostId = randomUUID();
  const token = 'notifications-token';
  const previousNotificationsWorkerDisabled = process.env.NOTIFICATIONS_WORKER_DISABLED;

  beforeAll(async () => {
    process.env.NOTIFICATIONS_WORKER_DISABLED = 'true';
    repository = new FakeNotificationsRepository();
    presenceChecker = new FakePresenceChecker();
    pushProvider = new FakePushProvider();

    const moduleRef = await Test.createTestingModule({
      imports: [NotificationsModule]
    })
      .overrideProvider(AuthService)
      .useValue(new FakeAuthService(new Map([[token, profileId]])))
      .overrideProvider(NOTIFICATIONS_REPOSITORY)
      .useValue(repository)
      .overrideProvider(NOTIFICATIONS_PRESENCE_CHECKER)
      .useValue(presenceChecker)
      .overrideProvider(PUSH_PROVIDER)
      .useValue(pushProvider)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(
      new ValidationPipe({
        forbidNonWhitelisted: true,
        transform: true,
        whitelist: true
      })
    );

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    consumer = moduleRef.get(NotificationsConsumer);
  });

  beforeEach(() => {
    repository.reset();
    presenceChecker.reset();
    pushProvider.reset();
  });

  afterAll(async () => {
    restoreEnv('NOTIFICATIONS_WORKER_DISABLED', previousNotificationsWorkerDisabled);
    await app.close();
  });

  it('stores FCM device tokens for the current user', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/me/devices',
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        token: 'fcm-device-token-1'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: expect.any(String),
      profile_id: profileId,
      token: 'fcm-device-token-1',
      created_at: '2026-06-17T08:00:00.000Z',
      updated_at: '2026-06-17T08:00:00.000Z',
      last_seen_at: '2026-06-17T08:00:00.000Z'
    });
    expect(repository.getDeviceTokens(profileId)).toEqual(['fcm-device-token-1']);
  });

  it('consumes booking and payment jobs with the notification templates and mute setting', async () => {
    const bookingId = randomUUID();
    const slotId = randomUUID();
    const activityId = randomUUID();
    const paymentId = randomUUID();

    repository.addDevice(explorerId, 'explorer-device-token');
    repository.addDevice(hostId, 'host-device-token');

    await expect(
      consumer.handleJob(
        domainEventJob(1, 'booking', bookingId, 'booking.confirmed', {
          booking_id: bookingId,
          slot_id: slotId,
          activity_id: activityId,
          explorer_id: explorerId,
          host_id: hostId,
          payment_id: paymentId,
          headcount: 1,
          amount_inr: 1499,
          confirmed_at: '2026-06-17T08:05:00.000Z',
          correlation_id: 'test-correlation-booking-confirmed'
        })
      )
    ).resolves.toMatchObject({
      recipients_considered: 2,
      pushes_sent: 2
    });
    expect(pushProvider.sentMessages).toEqual([
      {
        token: 'explorer-device-token',
        notification: {
          title: "You're in!",
          body: "You're in! Your Maidan booking is confirmed."
        },
        data: {
          event_type: 'booking.confirmed',
          domain_event_id: '1',
          booking_id: bookingId,
          activity_id: activityId,
          slot_id: slotId
        }
      },
      {
        token: 'host-device-token',
        notification: {
          title: "You're in!",
          body: "You're in! Your Maidan booking is confirmed."
        },
        data: {
          event_type: 'booking.confirmed',
          domain_event_id: '1',
          booking_id: bookingId,
          activity_id: activityId,
          slot_id: slotId
        }
      }
    ]);

    pushProvider.reset();
    repository.setMuted(hostId, true);
    await expect(
      consumer.handleJob(
        domainEventJob(2, 'booking', bookingId, 'booking.cancelled', {
          booking_id: bookingId,
          slot_id: slotId,
          activity_id: activityId,
          explorer_id: explorerId,
          host_id: hostId,
          payment_id: paymentId,
          previous_status: 'confirmed',
          headcount: 1,
          amount_inr: 1499,
          cancelled_at: '2026-06-17T09:00:00.000Z',
          correlation_id: 'test-correlation-booking-cancelled'
        })
      )
    ).resolves.toMatchObject({
      recipients_considered: 2,
      pushes_sent: 1,
      skipped_muted: 1
    });
    expect(pushProvider.sentMessages).toEqual([
      {
        token: 'explorer-device-token',
        notification: {
          title: 'Booking cancelled',
          body: 'Your Maidan booking has been cancelled.'
        },
        data: {
          event_type: 'booking.cancelled',
          domain_event_id: '2',
          booking_id: bookingId,
          activity_id: activityId,
          slot_id: slotId
        }
      }
    ]);

    pushProvider.reset();
    repository.setBookingExplorer(bookingId, explorerId);
    await consumer.handleJob(
      domainEventJob(3, 'payment', paymentId, 'payment.failed', {
        payment_id: paymentId,
        booking_id: bookingId,
        phonepe_order_id: 'phonepe-order-1',
        amount_inr: 1499,
        failure_code: 'AUTHORIZATION_FAILED',
        failure_reason: 'Payment authorization failed',
        failed_at: '2026-06-17T09:05:00.000Z',
        correlation_id: 'test-correlation-payment-failed'
      })
    );
    expect(pushProvider.sentMessages).toEqual([
      {
        token: 'explorer-device-token',
        notification: {
          title: 'Payment failed',
          body: "Your payment didn't go through. Please try again."
        },
        data: {
          event_type: 'payment.failed',
          domain_event_id: '3',
          booking_id: bookingId,
          payment_id: paymentId
        }
      }
    ]);
  });

  it('only pushes message.created notifications to offline recipients', async () => {
    const chatId = randomUUID();
    const messageId = randomUUID();
    const activityId = randomUUID();
    const offlineRecipientId = randomUUID();
    const onlineRecipientId = randomUUID();
    const senderId = randomUUID();

    repository.addDevice(offlineRecipientId, 'offline-device-token');
    repository.addDevice(onlineRecipientId, 'online-device-token');
    repository.setChatRecipients(chatId, [offlineRecipientId, onlineRecipientId, senderId]);
    presenceChecker.setOnline(onlineRecipientId, true);

    await expect(
      consumer.handleJob(
        domainEventJob(4, 'message', messageId, 'message.created', {
          message_id: messageId,
          chat_id: chatId,
          sender_id: senderId,
          activity_id: activityId,
          body: 'See you at the trailhead.',
          created_at: '2026-06-17T09:10:00.000Z',
          correlation_id: 'test-correlation-message-created'
        })
      )
    ).resolves.toMatchObject({
      recipients_considered: 2,
      pushes_sent: 1,
      skipped_online: 1
    });
    expect(pushProvider.sentMessages).toEqual([
      {
        token: 'offline-device-token',
        notification: {
          title: 'New message',
          body: 'See you at the trailhead.'
        },
        data: {
          event_type: 'message.created',
          domain_event_id: '4',
          message_id: messageId,
          chat_id: chatId,
          activity_id: activityId
        }
      }
    ]);
  });

  it('pushes severe moderation.blocked notifications to the author', async () => {
    const targetId = randomUUID();
    const authorId = randomUUID();

    repository.addDevice(authorId, 'author-device-token');

    await expect(
      consumer.handleJob(
        domainEventJob(5, 'moderation', targetId, 'moderation.blocked', {
          target_type: 'message',
          target_id: targetId,
          author_id: authorId,
          severity: 3,
          categories: ['violence', 'harassment'],
          reason: 'Threatens physical harm.',
          created_at: '2026-06-17T09:15:00.000Z',
          correlation_id: 'test-correlation-moderation-blocked'
        })
      )
    ).resolves.toMatchObject({
      recipients_considered: 1,
      pushes_sent: 1
    });
    expect(pushProvider.sentMessages).toEqual([
      {
        token: 'author-device-token',
        notification: {
          title: 'Content hidden',
          body: 'Your recent content was hidden because it broke Maidan community guidelines.'
        },
        data: {
          event_type: 'moderation.blocked',
          domain_event_id: '5',
          target_type: 'message',
          target_id: targetId,
          severity: '3'
        }
      }
    ]);
  });
});

function domainEventJob(
  id: number,
  aggregateType: string,
  aggregateId: string,
  eventType: string,
  payload: Record<string, unknown>
): DomainEventJobData {
  return {
    id,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    event_type: eventType,
    payload,
    created_at: '2026-06-17T08:00:00.000Z',
    stream_entry_id: `${id}-0`
  };
}

function restoreEnv(name: string, originalValue: string | undefined): void {
  if (originalValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = originalValue;
  }
}
