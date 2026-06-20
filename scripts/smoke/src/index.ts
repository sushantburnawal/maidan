import { createHash, randomUUID } from 'node:crypto';

import { QUEUE_NOTIFICATIONS } from '@maidan/shared';

import { assertSmoke, formatValue, poll } from './assert';
import { loadSmokeConfig, type SmokeConfig } from './config';
import type {
  ActivityDetailResponse,
  ActivityResponse,
  ActivitySlot,
  ActivityVibeResponse,
  AiMetricsResponse,
  AuthTokens,
  Booking,
  CreateActivityDto,
  CreateBookingDto,
  CreateSlotDto,
  FeedPostRecord,
  GroupChatRecord,
  HealthResponse,
  HostProfileRecord,
  InitPaymentDto,
  InitPaymentResponse,
  MessageRecord,
  NearbyActivityResponse,
  OtpState,
  PaginatedMessagesResponse,
  PaginatedPostsResponse,
  Payment,
  PaymentWebhookResponse,
  Profile,
  SutradharFinalEvent
} from './contracts';
import { runCommand } from './exec';
import { HttpClient, SmokeHttpError } from './http';
import { PgHelper, sqlString, sqlUuid, sqlUuidArray } from './pg';
import { RedisHelper } from './redis';
import { SocketHelper } from './socket';

interface AuthContext {
  label: string;
  phone: string;
  profileId: string;
  accessToken: string;
  refreshToken: string;
}

interface SmokeState {
  runId: string;
  phones: string[];
  profileIds: string[];
  activityIds: string[];
  slotIds: string[];
  bookingIds: string[];
  paymentIds: string[];
  messageIds: string[];
}

interface CreateBookingSmokeResponse {
  booking: Booking;
  payment_required_next: boolean;
}

interface StepContext {
  config: SmokeConfig;
  api: HttpClient;
  ai: HttpClient;
  pg: PgHelper;
  redis: RedisHelper;
  state: SmokeState;
  host?: AuthContext;
  explorer?: AuthContext;
  activity?: ActivityResponse;
  mainSlot?: ActivitySlot;
  concurrencySlot?: ActivitySlot;
  mainBooking?: Booking;
  payment?: Payment;
  webhookBody?: Record<string, unknown>;
  webhookAuthorization?: string;
  notificationQueueBaseline?: number;
  bullmqPrefix?: string;
  chat?: GroupChatRecord;
}

interface SlotStateRow {
  id: string;
  booked_count: number;
  capacity: number;
  status: string;
}

interface EventCountRow {
  count: number;
}

interface EventProcessedRow {
  total: number;
  processed: number;
}

interface ProfileRow {
  id: string;
  phone: string;
}

interface ChatMembersRow {
  chat_id: string;
  member_count: number;
}

interface SutradharParsedResponse {
  text: string;
  finalEvent: SutradharFinalEvent | null;
}

const NandiTitle = 'Nandi Hills sunrise trail ride';

async function main(): Promise<void> {
  const config = loadSmokeConfig();
  const state: SmokeState = {
    runId: `smoke-${Date.now()}-${randomUUID().slice(0, 8)}`,
    phones: [],
    profileIds: [],
    activityIds: [],
    slotIds: [],
    bookingIds: [],
    paymentIds: [],
    messageIds: []
  };
  const context: StepContext = {
    config,
    api: new HttpClient(config.apiBaseUrl),
    ai: new HttpClient(config.aiBaseUrl),
    pg: new PgHelper(config),
    redis: new RedisHelper(config),
    state
  };

  let failed = false;

  try {
    await step('HEALTH api + ai ready', () => healthStep(context));
    await step('AUTH host/explorer OTP', () => authStep(context));
    await step('DISCOVER Nandi seed geo', () => discoverStep(context));
    await step('FIXTURES activity + slots', () => fixturesStep(context));
    await step('DETAIL activity + vibe', () => detailStep(context));
    await step('BOOK slot row lock + outbox', () => bookStep(context));
    await step('PAY fake gateway success', () => payStep(context));
    await step('IDEMPOTENCY replay callback', () => idempotencyStep(context));
    await step('MEANING PLANE async effects', () => meaningPlaneStep(context));
    await step('REALTIME socket.io chat', () => realtimeStep(context));
    await step('FEED seeded activity card', () => feedStep(context));
    await step('SUTRADHAR grounded + cost', () => sutradharStep(context));
    await step('CONCURRENCY capacity=1', () => concurrencyStep(context));
  } catch {
    failed = true;
  } finally {
    await cleanup(context);
  }

  if (failed) {
    process.exitCode = 1;
  }
}

async function step(name: string, run: () => Promise<void>): Promise<void> {
  const startedAt = Date.now();

  try {
    await run();
    console.log(`PASS ${name} (${Date.now() - startedAt}ms)`);
  } catch (error) {
    console.error(`FAIL ${name} (${Date.now() - startedAt}ms)`);

    if (error instanceof SmokeHttpError) {
      console.error(`  ${error.message}`);
      if (error.correlationId !== undefined) {
        console.error(`  correlation_id=${error.correlationId}`);
      }
    } else if (error instanceof Error) {
      console.error(`  ${error.message}`);
    } else {
      console.error(`  ${formatValue(error)}`);
    }

    throw error;
  }
}

async function healthStep(context: StepContext): Promise<void> {
  const apiReady = await context.api.get<HealthResponse>('/health/ready');
  assertSmoke(apiReady.status === 'ok', 'API readiness was not ok', apiReady);

  const aiHealth = await context.ai.get<HealthResponse>('/health');
  assertSmoke(aiHealth.status === 'ok', 'AI health was not ok', aiHealth);
}

async function authStep(context: StepContext): Promise<void> {
  context.host = await authenticate(context, 'host', 1);
  context.explorer = await authenticate(context, 'explorer', 2);

  await context.api.patch(
    '/me',
    {
      display_name: `${context.state.runId} Host`,
      interests: ['cycling', 'coffee', 'mindfulness'],
      home_location: { lat: 12.9784, lng: 77.6408 }
    },
    { token: context.host.accessToken }
  );
  await context.api.patch(
    '/me',
    {
      display_name: `${context.state.runId} Explorer`,
      interests: ['sunrise', 'cycling', 'calm'],
      home_location: { lat: 12.9784, lng: 77.6408 }
    },
    { token: context.explorer.accessToken }
  );
}

async function authenticate(context: StepContext, label: string, offset: number): Promise<AuthContext> {
  const phone = smokePhone(offset);
  const otpKey = `otp:${phone}`;
  context.state.phones.push(phone);

  await context.api.post('/auth/request-otp', { phone });

  const otpRaw = await context.redis.get(otpKey);
  assertSmoke(otpRaw !== null, `OTP Redis key was not created for ${label}`, { otpKey });

  const otp = JSON.parse(otpRaw) as OtpState;
  assertSmoke(/^[0-9]{6}$/.test(otp.code), 'OTP value was not a 6 digit code', otp);

  const tokens = await context.api.post<AuthTokens>('/auth/verify-otp', {
    phone,
    code: otp.code
  });
  assertSmoke(tokens.accessToken.length > 0, 'verify-otp did not return accessToken', tokens);
  assertSmoke(tokens.refreshToken.length > 0, 'verify-otp did not return refreshToken', tokens);
  assertSmoke(!(await context.redis.exists(otpKey)), 'OTP Redis key was not consumed after verify', {
    otpKey
  });

  const profile = await context.pg.queryOne<ProfileRow>(
    `select id, phone from profiles where phone = ${sqlString(phone)}`
  );
  assertSmoke(profile !== null, 'profiles row was not created after OTP verify', { phone });
  context.state.profileIds.push(profile.id);

  return {
    label,
    phone,
    profileId: profile.id,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken
  };
}

async function discoverStep(context: StepContext): Promise<void> {
  const nearby = await context.api.get<NearbyActivityResponse[]>('/activities/nearby', {
    query: { lat: 13.37, lng: 77.68, radiusKm: 10 }
  });
  const nandi = nearby.find((activity) => activity.title === NandiTitle);

  assertSmoke(nandi !== undefined, 'Nandi Hills seed activity was not returned near Nandi Hills', nearby);
  assertSmoke(nandi.distance_m !== null, 'Nandi Hills seed activity did not include distance_m', nandi);
  assertSmoke(nandi.fairness !== undefined, 'Nandi Hills seed activity did not include fairness', nandi);
  assertSmoke(nandi.next_open_slot !== null, 'Nandi Hills seed activity did not include next_open_slot', nandi);

  const farAway = await context.api.get<NearbyActivityResponse[]>('/activities/nearby', {
    query: { lat: 8.5, lng: 76.9, radiusKm: 2 }
  });
  assertSmoke(
    !farAway.some((activity) => activity.title === NandiTitle),
    'Nandi Hills seed activity was returned for a distant 2km query',
    farAway
  );
}

async function fixturesStep(context: StepContext): Promise<void> {
  const host = requireAuth(context.host, 'host');
  const hostProfile = await context.api.post<HostProfileRecord>(
    '/me/become-host',
    undefined,
    { token: host.accessToken }
  );
  assertSmoke(hostProfile.profile_id === host.profileId, 'become-host returned an unexpected profile', hostProfile);

  await context.pg.execute(`
    update host_profiles
    set payout_ref = ${sqlString(`${context.state.runId}-payout`)}
    where profile_id = ${sqlUuid(host.profileId)}
  `);

  const createActivityBody: CreateActivityDto = {
    title: `${context.state.runId} Indiranagar sunrise flow`,
    description: 'A small smoke-test fixture for a calm morning movement session.',
    pillar: 'move',
    category: 'cycling',
    meetingPoint: `${context.state.runId} smoke meeting point`,
    location: { lat: 12.9784, lng: 77.6408 },
    basePriceInr: 500,
    capacity: 2,
    media: []
  };
  const draft = await context.api.post<ActivityResponse>('/activities', createActivityBody, {
    token: host.accessToken
  });
  context.state.activityIds.push(draft.id);

  context.activity = await context.api.post<ActivityResponse>(`/activities/${draft.id}/publish`, undefined, {
    token: host.accessToken
  });

  context.mainSlot = await createSlot(context, draft.id, host.accessToken, 1, 1);
  context.concurrencySlot = await createSlot(context, draft.id, host.accessToken, 1, 2);
}

async function createSlot(
  context: StepContext,
  activityId: string,
  token: string,
  capacity: number,
  dayOffset: number
): Promise<ActivitySlot> {
  const startsAt = new Date(Date.now() + dayOffset * 24 * 60 * 60 * 1000 + 9 * 60 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + 90 * 60 * 1000);
  const body: CreateSlotDto = {
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    capacity
  };
  const slot = await context.api.post<ActivitySlot>(`/activities/${activityId}/slots`, body, { token });

  context.state.slotIds.push(slot.id);
  return slot;
}

async function detailStep(context: StepContext): Promise<void> {
  const activity = requireValue(context.activity, 'activity');
  const detail = await context.api.get<ActivityDetailResponse>(`/activities/${activity.id}`);

  assertSmoke(detail.fairness !== undefined, 'Activity detail did not include fairness', detail);
  assertSmoke(
    detail.upcoming_open_slots.some((slot) => slot.id === requireValue(context.mainSlot, 'mainSlot').id),
    'Activity detail did not include the main open slot',
    detail
  );

  const vibe = await context.api.get<ActivityVibeResponse>(`/activities/${activity.id}/vibe`);
  assertSmoke(vibe.activity_id === activity.id, 'Activity vibe returned a different activity id', vibe);
  assertSmoke(typeof vibe.summary === 'string' && vibe.summary.length > 0, 'Activity vibe summary was empty', vibe);
}

async function bookStep(context: StepContext): Promise<void> {
  const explorer = requireAuth(context.explorer, 'explorer');
  const slot = requireValue(context.mainSlot, 'mainSlot');
  const baseline = await readSlotState(context, slot.id);

  assertSmoke(baseline.booked_count === 0, 'Main fixture slot baseline was not empty', baseline);

  const body: CreateBookingDto = {
    slotId: slot.id,
    headcount: 1
  };
  const created = await context.api.post<CreateBookingSmokeResponse>('/bookings', body, {
    token: explorer.accessToken
  });
  const { booking } = created;
  context.mainBooking = booking;
  context.state.bookingIds.push(booking.id);

  const slotAfter = await poll(
    () => readSlotState(context, slot.id),
    (row) => row.booked_count === baseline.booked_count + 1 && row.status === 'full',
    {
      description: 'booked_count increment and full slot status'
    }
  );
  assertSmoke(slotAfter.capacity === 1, 'Main slot capacity changed unexpectedly', slotAfter);

  const events = await context.pg.queryRows<EventCountRow>(
    `
      select count(*)::int as count
      from domain_events
      where aggregate_id = ${sqlUuid(booking.id)}
        and event_type = 'booking.created'
    `
  );
  assertSmoke(events[0]?.count === 1, 'booking.created event was not written with the booking', events);
}

async function payStep(context: StepContext): Promise<void> {
  const explorer = requireAuth(context.explorer, 'explorer');
  const booking = requireValue(context.mainBooking, 'mainBooking');
  const bullmqPrefix = await apiContainerEnv(context, 'BULLMQ_PREFIX');
  context.bullmqPrefix = bullmqPrefix.length > 0 ? bullmqPrefix : context.config.bullmqPrefix;
  context.notificationQueueBaseline = await context.redis.queueActivity(
    context.bullmqPrefix,
    QUEUE_NOTIFICATIONS
  );

  const body: InitPaymentDto = { bookingId: booking.id };
  const init = await context.api.post<InitPaymentResponse>('/payments/init', body, {
    token: explorer.accessToken
  });

  context.payment = init.payment;
  context.state.paymentIds.push(init.payment.id);
  assertSmoke(!init.already_paid, 'Fresh payment init unexpectedly returned already_paid', init);
  assertSmoke(
    init.payment.platform_fee_inr + init.payment.host_payout_inr === init.payment.amount_inr,
    'Payment split did not reconcile after init',
    init.payment
  );

  const authorization = await phonePeWebhookAuthorization(context);
  const callbackBody = {
    event: 'checkout.order.completed',
    payload: {
      merchantOrderId: init.payment.phonepe_order_id,
      state: 'COMPLETED',
      amount: init.payment.amount_inr * 100,
      paymentDetails: [
        {
          transactionId: `${context.state.runId}-txn`
        }
      ]
    }
  };
  context.webhookBody = callbackBody;
  context.webhookAuthorization = authorization;

  const webhook = await context.api.post<PaymentWebhookResponse>('/payments/webhook', callbackBody, {
    headers: { authorization }
  });
  assertSmoke(webhook.received && webhook.applied, 'Payment webhook was not applied', webhook);

  const payment = await poll(
    () => readPayment(context, init.payment.id),
    (row) => row?.status === 'success',
    { description: 'payment success row' }
  );
  assertSmoke(payment !== null, 'Payment row disappeared after webhook', { paymentId: init.payment.id });
  assertSmoke(
    payment.platform_fee_inr + payment.host_payout_inr === payment.amount_inr,
    'Successful payment split did not reconcile',
    payment
  );

  const confirmed = await poll(
    () => readBooking(context, booking.id),
    (row) => row?.status === 'confirmed',
    { description: 'booking confirmed row' }
  );
  assertSmoke(confirmed !== null, 'Booking row disappeared after payment', { bookingId: booking.id });

  const events = await context.pg.queryRows<{ event_type: string; count: number }>(
    `
      select event_type, count(*)::int as count
      from domain_events
      where (aggregate_id = ${sqlUuid(payment.id)} and event_type = 'payment.succeeded')
         or (aggregate_id = ${sqlUuid(booking.id)} and event_type = 'booking.confirmed')
      group by event_type
    `
  );
  assertSmoke(
    eventCount(events, 'payment.succeeded') === 1 && eventCount(events, 'booking.confirmed') === 1,
    'Payment success and booking confirmed events were not written',
    events
  );
}

async function idempotencyStep(context: StepContext): Promise<void> {
  const payment = requireValue(context.payment, 'payment');
  const booking = requireValue(context.mainBooking, 'mainBooking');
  const callbackBody = requireValue(context.webhookBody, 'webhookBody');
  const authorization = requireValue(context.webhookAuthorization, 'webhookAuthorization');
  const before = await eventCountsForPaymentReplay(context, payment.id, booking.id);

  const replay = await context.api.post<PaymentWebhookResponse>('/payments/webhook', callbackBody, {
    headers: { authorization }
  });
  assertSmoke(replay.received, 'Replay webhook was not accepted as received', replay);
  assertSmoke(!replay.applied, 'Replay webhook was applied instead of being a no-op', replay);

  const afterPayment = await readPayment(context, payment.id);
  assertSmoke(afterPayment?.status === 'success', 'Payment status changed after replay', afterPayment);

  const after = await eventCountsForPaymentReplay(context, payment.id, booking.id);
  assertSmoke(
    before.paymentSucceeded === after.paymentSucceeded && before.bookingConfirmed === after.bookingConfirmed,
    'Replay webhook created duplicate terminal events',
    { before, after }
  );
}

async function meaningPlaneStep(context: StepContext): Promise<void> {
  const activity = requireValue(context.activity, 'activity');
  const host = requireAuth(context.host, 'host');
  const explorer = requireAuth(context.explorer, 'explorer');
  const booking = requireValue(context.mainBooking, 'mainBooking');
  const payment = requireValue(context.payment, 'payment');
  const bullmqPrefix = requireValue(context.bullmqPrefix, 'bullmqPrefix');
  const queueBaseline = requireValue(context.notificationQueueBaseline, 'notificationQueueBaseline');

  const processed = await poll(
    () => processedEventSummary(context, [booking.id, payment.id]),
    (row) => row.total >= 3 && row.processed >= 3,
    { description: 'domain_events.processed_at for booking and payment events' }
  );
  assertSmoke(processed.total >= 3, 'Expected booking/payment domain events were missing', processed);

  const chatMembers = await poll(
    () => readChatMembers(context, activity.id, [host.profileId, explorer.profileId]),
    (row) => row !== null && row.member_count === 2,
    { description: 'booking chat host and explorer members' }
  );
  assertSmoke(chatMembers !== null, 'Booking chat was not created', { activityId: activity.id });
  context.chat = {
    id: chatMembers.chat_id,
    activity_id: activity.id,
    title: activity.title,
    created_at: new Date().toISOString()
  };

  const matchScoreCount = await poll(
    () =>
      context.pg.scalar(
        `select count(*)::int from match_scores where activity_id = ${sqlUuid(activity.id)}`
      ),
    (value) => Number(value) > 0,
    { description: 'match_scores for smoke activity' }
  );
  assertSmoke(Number(matchScoreCount) > 0, 'No match_scores were written for the activity', matchScoreCount);

  const embeddingReady = await poll(
    () =>
      context.pg.scalar(
        `select (embedding is not null)::text from activities where id = ${sqlUuid(activity.id)}`
      ),
    (value) => value === 'true',
    { description: 'activity embedding populated' }
  );
  assertSmoke(embeddingReady === 'true', 'Activity embedding was not populated', { activityId: activity.id });

  const queueActivity = await poll(
    () => context.redis.queueActivity(bullmqPrefix, QUEUE_NOTIFICATIONS),
    (value) => value > queueBaseline,
    { description: 'notification BullMQ enqueue activity' }
  );
  assertSmoke(queueActivity > queueBaseline, 'Notification queue activity did not increase', {
    before: queueBaseline,
    after: queueActivity,
    queue: QUEUE_NOTIFICATIONS
  });
}

async function realtimeStep(context: StepContext): Promise<void> {
  const host = requireAuth(context.host, 'host');
  const explorer = requireAuth(context.explorer, 'explorer');
  const chat = requireValue(context.chat, 'chat');
  let hostSocket: SocketHelper | undefined;
  let explorerSocket: SocketHelper | undefined;

  try {
    hostSocket = await SocketHelper.connect(context.config.apiBaseUrl, host.accessToken);
    explorerSocket = await SocketHelper.connect(context.config.apiBaseUrl, explorer.accessToken);

    await hostSocket.join(chat.id);
    await explorerSocket.join(chat.id);

    const body = `${context.state.runId} realtime hello`;
    const receivedPromise = hostSocket.waitForMessage(body);
    const sent = await explorerSocket.sendMessage(chat.id, body);
    const received = await receivedPromise;

    context.state.messageIds.push(sent.id);
    assertSmoke(received.id === sent.id, 'message:new broadcast did not match sent message', {
      sent,
      received
    });

    const messageRow = await poll(
      () => readMessage(context, sent.id),
      (row) => row !== null,
      { description: 'persisted socket message row' }
    );
    assertSmoke(messageRow !== null, 'Socket message was not persisted', sent);

    const eventCountValue = await poll(
      () =>
        context.pg.scalar(
          `
            select count(*)::int
            from domain_events
            where aggregate_id = ${sqlUuid(sent.id)}
              and event_type = 'message.created'
          `
        ),
      (value) => Number(value) === 1,
      { description: 'message.created domain event' }
    );
    assertSmoke(Number(eventCountValue) === 1, 'message.created event was not written', {
      messageId: sent.id
    });

    const history = await context.api.get<PaginatedMessagesResponse>(`/chats/${chat.id}/messages`, {
      token: explorer.accessToken
    });
    assertSmoke(
      history.items.some((message) => message.id === sent.id && message.body === body),
      'GET /chats/:id/messages did not return persisted socket history',
      history
    );
  } finally {
    hostSocket?.close();
    explorerSocket?.close();
  }
}

async function feedStep(context: StepContext): Promise<void> {
  const feed = await context.api.get<PaginatedPostsResponse>('/feed', {
    query: { limit: 20 }
  });
  const nandiPost = feed.items.find(isNandiFeedPost);

  assertSmoke(nandiPost !== undefined, 'Feed did not include the seeded Nandi activity card post', feed);
}

async function sutradharStep(context: StepContext): Promise<void> {
  const explorer = requireAuth(context.explorer, 'explorer');
  const before = await context.ai.get<AiMetricsResponse>('/internal/metrics');
  const body = await context.api.text('POST', '/sutradhar/chat', {
    token: explorer.accessToken,
    body: {
      message: 'a calm morning thing near Indiranagar',
      sessionId: context.state.runId
    }
  });
  const parsed = parseSutradharResponse(body);
  const activityIds = parsed.finalEvent?.activity_ids ?? [];

  assertSmoke(activityIds.length > 0, 'Sutradhar final event did not include activity ids', {
    text: parsed.text,
    finalEvent: parsed.finalEvent,
    raw: body
  });

  const existingCount = await context.pg.scalar(
    `
      select count(*)::int
      from activities
      where id = any(${sqlUuidArray(activityIds)})
    `
  );
  assertSmoke(
    Number(existingCount) === activityIds.length,
    'Sutradhar returned activity ids that do not exist in the DB',
    { activityIds, existingCount }
  );

  const after = await poll(
    () => context.ai.get<AiMetricsResponse>('/internal/metrics'),
    (metrics) => metrics.claude.today.sonnet.calls > before.claude.today.sonnet.calls,
    { description: 'Claude Sonnet cost metric increment' }
  );
  assertSmoke(
    after.claude.today.sonnet.calls > before.claude.today.sonnet.calls,
    'Claude Sonnet call count did not increment',
    { before: before.claude.today.sonnet, after: after.claude.today.sonnet }
  );
}

async function concurrencyStep(context: StepContext): Promise<void> {
  const explorer = requireAuth(context.explorer, 'explorer');
  const slot = requireValue(context.concurrencySlot, 'concurrencySlot');
  const body: CreateBookingDto = {
    slotId: slot.id,
    headcount: 1
  };

  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      context.api.raw<CreateBookingSmokeResponse>('POST', '/bookings', {
        token: explorer.accessToken,
        body
      })
    )
  );
  const successes = results.filter((result) => result.ok);
  const failures = results.filter((result) => !result.ok);

  for (const success of successes) {
    if (success.body !== null) {
      context.state.bookingIds.push(success.body.booking.id);
    }
  }

  assertSmoke(successes.length === 1, 'Capacity=1 concurrency slot did not allow exactly one booking', {
    successes: successes.length,
    failures: failures.map((failure) => ({
      status: failure.status,
      correlationId: failure.correlationId,
      body: failure.body
    }))
  });

  const slotAfter = await readSlotState(context, slot.id);
  assertSmoke(
    slotAfter.booked_count === 1 && slotAfter.status === 'full',
    'Concurrency slot did not end with booked_count=1 and status=full',
    slotAfter
  );
}

async function cleanup(context: StepContext): Promise<void> {
  if (process.env.SMOKE_CLEANUP === 'false') {
    return;
  }

  const { state } = context;
  const hasCreatedRows =
    state.profileIds.length > 0 ||
    state.activityIds.length > 0 ||
    state.slotIds.length > 0 ||
    state.bookingIds.length > 0 ||
    state.paymentIds.length > 0 ||
    state.messageIds.length > 0;

  if (!hasCreatedRows) {
    return;
  }

  try {
    await context.pg.execute(`
      update bookings
      set payment_id = null
      where id = any(${sqlUuidArray(state.bookingIds)});

      delete from domain_events
      where aggregate_id = any(${sqlUuidArray([
        ...state.activityIds,
        ...state.bookingIds,
        ...state.paymentIds,
        ...state.messageIds
      ])})
         or payload::text like ${sqlString(`%${state.runId}%`)};

      delete from payments
      where id = any(${sqlUuidArray(state.paymentIds)})
         or booking_id = any(${sqlUuidArray(state.bookingIds)});

      delete from bookings
      where id = any(${sqlUuidArray(state.bookingIds)})
         or slot_id = any(${sqlUuidArray(state.slotIds)});

      delete from activity_slots
      where id = any(${sqlUuidArray(state.slotIds)})
         or activity_id = any(${sqlUuidArray(state.activityIds)});

      delete from activities
      where id = any(${sqlUuidArray(state.activityIds)})
         or title like ${sqlString(`${state.runId}%`)};

      delete from auth.users
      where id = any(${sqlUuidArray(state.profileIds)});
    `);
  } catch (error) {
    console.error(`WARN cleanup failed: ${error instanceof Error ? error.message : formatValue(error)}`);
  }
}

async function readSlotState(context: StepContext, slotId: string): Promise<SlotStateRow> {
  const row = await context.pg.queryOne<SlotStateRow>(
    `
      select id, booked_count, capacity, status
      from activity_slots
      where id = ${sqlUuid(slotId)}
    `
  );

  return requireValue(row, `slot ${slotId}`);
}

async function readPayment(context: StepContext, paymentId: string): Promise<Payment | null> {
  return context.pg.queryOne<Payment>(
    `
      select
        id,
        booking_id,
        phonepe_order_id,
        phonepe_txn_id,
        amount_inr,
        platform_fee_inr,
        host_payout_inr,
        status,
        idempotency_key,
        raw_callback,
        created_at,
        updated_at
      from payments
      where id = ${sqlUuid(paymentId)}
    `
  );
}

async function readBooking(context: StepContext, bookingId: string): Promise<Booking | null> {
  return context.pg.queryOne<Booking>(
    `
      select id, slot_id, explorer_id, headcount, amount_inr, status, payment_id, created_at, updated_at
      from bookings
      where id = ${sqlUuid(bookingId)}
    `
  );
}

async function readMessage(context: StepContext, messageId: string): Promise<MessageRecord | null> {
  return context.pg.queryOne<MessageRecord>(
    `
      select id, chat_id, sender_id, body, created_at
      from messages
      where id = ${sqlUuid(messageId)}
    `
  );
}

async function processedEventSummary(
  context: StepContext,
  aggregateIds: string[]
): Promise<EventProcessedRow> {
  const row = await context.pg.queryOne<EventProcessedRow>(
    `
      select
        count(*)::int as total,
        count(processed_at)::int as processed
      from domain_events
      where aggregate_id = any(${sqlUuidArray(aggregateIds)})
        and event_type in ('booking.created', 'payment.succeeded', 'booking.confirmed')
    `
  );

  return requireValue(row, 'processed event summary');
}

async function readChatMembers(
  context: StepContext,
  activityId: string,
  memberIds: string[]
): Promise<ChatMembersRow | null> {
  return context.pg.queryOne<ChatMembersRow>(
    `
      select gc.id as chat_id, count(cm.profile_id)::int as member_count
      from group_chats gc
      join chat_members cm on cm.chat_id = gc.id
      where gc.activity_id = ${sqlUuid(activityId)}
        and cm.profile_id = any(${sqlUuidArray(memberIds)})
      group by gc.id
    `
  );
}

async function eventCountsForPaymentReplay(
  context: StepContext,
  paymentId: string,
  bookingId: string
): Promise<{ paymentSucceeded: number; bookingConfirmed: number }> {
  const rows = await context.pg.queryRows<{ event_type: string; count: number }>(
    `
      select event_type, count(*)::int as count
      from domain_events
      where (aggregate_id = ${sqlUuid(paymentId)} and event_type = 'payment.succeeded')
         or (aggregate_id = ${sqlUuid(bookingId)} and event_type = 'booking.confirmed')
      group by event_type
    `
  );

  return {
    paymentSucceeded: eventCount(rows, 'payment.succeeded'),
    bookingConfirmed: eventCount(rows, 'booking.confirmed')
  };
}

function eventCount(rows: Array<{ event_type: string; count: number }>, eventType: string): number {
  return rows.find((row) => row.event_type === eventType)?.count ?? 0;
}

async function phonePeWebhookAuthorization(context: StepContext): Promise<string> {
  const [username, password, secret] = await Promise.all([
    apiContainerEnv(context, 'PHONEPE_WEBHOOK_USERNAME'),
    apiContainerEnv(context, 'PHONEPE_WEBHOOK_PASSWORD'),
    apiContainerEnv(context, 'PHONEPE_WEBHOOK_SECRET')
  ]);

  if (username.length > 0 && password.length > 0) {
    return createWebhookAuthorization(`${username}:${password}`);
  }

  if (secret.length > 0) {
    return createWebhookAuthorization(secret);
  }

  throw new Error(
    'PHONEPE_WEBHOOK_USERNAME/PASSWORD or PHONEPE_WEBHOOK_SECRET is not configured in the live API container'
  );
}

function createWebhookAuthorization(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function apiContainerEnv(context: StepContext, name: string): Promise<string> {
  try {
    const result = await runCommand(
      'docker',
      [
        ...context.config.dockerComposeArgs,
        'exec',
        '-T',
        context.config.services.api,
        'printenv',
        name
      ],
      { cwd: context.config.repoRoot }
    );

    return result.stdout.trim();
  } catch {
    return '';
  }
}

function parseSutradharResponse(body: string): SutradharParsedResponse {
  const lines = body.split(/\r?\n/);
  const deltas: string[] = [];
  let finalEvent: SutradharFinalEvent | null = null;

  for (const line of lines) {
    if (!line.startsWith('data:')) {
      continue;
    }

    const data = line.slice('data:'.length).trim();

    if (data.length === 0 || data === '[DONE]') {
      continue;
    }

    const event = JSON.parse(data) as { type?: unknown; text?: unknown; activity_ids?: unknown };

    if (event.type === 'delta' && typeof event.text === 'string') {
      deltas.push(event.text);
    }

    if (event.type === 'final') {
      finalEvent = {
        type: 'final',
        activity_ids: Array.isArray(event.activity_ids)
          ? event.activity_ids.filter((value): value is string => typeof value === 'string')
          : undefined
      };
    }
  }

  return {
    text: deltas.join(''),
    finalEvent
  };
}

function isNandiFeedPost(post: FeedPostRecord): boolean {
  return post.linked_activity?.title === NandiTitle && post.body.toLowerCase().includes('nandi');
}

function smokePhone(offset: number): string {
  const local = 8_800_000_000 + (Date.now() % 100_000_000) + offset;

  return `+91${String(local).slice(0, 10)}`;
}

function requireAuth(value: AuthContext | undefined, label: string): AuthContext {
  return requireValue(value, label);
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Missing smoke state: ${label}`);
  }

  return value;
}

void main();
