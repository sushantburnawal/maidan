import { BadRequestException, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import type { PaymentStatus } from '@maidan/shared';
import { AuthService } from '../src/auth/auth.service';
import type { AuthenticatedUser } from '../src/auth/auth.types';
import {
  createPhonePeWebhookAuthorizationFromSecret,
  FakePaymentGateway,
  type PaymentGatewayCreateOrderInput,
  type PaymentGatewayRefundResult,
  type VerifiedPaymentWebhook
} from '../src/payments/payment-gateway';
import { PAYMENT_GATEWAY, PAYMENTS_REPOSITORY } from '../src/payments/payments.constants';
import { PaymentsModule } from '../src/payments/payments.module';
import { computePaymentSplit } from '../src/payments/payments.splits';
import type {
  InitiatePaymentRepositoryInput,
  InitiatePaymentRepositoryResult,
  InitPaymentResponse,
  PaymentRecord,
  PaymentsRepository,
  PaymentWebhookRepositoryResult,
  PaymentWebhookResponse,
  RefundablePaymentRecord
} from '../src/payments/payments.types';

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

interface FakeBooking {
  id: string;
  slot_id: string;
  activity_id: string;
  explorer_id: string;
  host_id: string;
  host_payout_ref: string | null;
  headcount: number;
  amount_inr: number;
  status: 'pending' | 'confirmed' | 'cancelled' | 'refunded';
  payment_id: string | null;
}

interface FakeDomainEvent {
  aggregate_type: 'booking' | 'payment';
  aggregate_id: string;
  event_type: 'booking.confirmed' | 'payment.succeeded' | 'payment.failed';
  payload: Record<string, unknown>;
}

class FakePaymentsRepository implements PaymentsRepository {
  private readonly bookings = new Map<string, FakeBooking>();
  private readonly payments = new Map<string, PaymentRecord>();
  private readonly domainEvents: FakeDomainEvent[] = [];

  reset(): void {
    this.bookings.clear();
    this.payments.clear();
    this.domainEvents.length = 0;
  }

  addBooking(input: {
    explorer_id: string;
    amount_inr: number;
    host_payout_ref?: string | null;
  }): string {
    const id = randomUUID();

    this.bookings.set(id, {
      id,
      slot_id: randomUUID(),
      activity_id: randomUUID(),
      explorer_id: input.explorer_id,
      host_id: randomUUID(),
      host_payout_ref: input.host_payout_ref ?? 'phonepe-settlement-host',
      headcount: 1,
      amount_inr: input.amount_inr,
      status: 'pending',
      payment_id: null
    });

    return id;
  }

  getBooking(bookingId: string): FakeBooking | undefined {
    const booking = this.bookings.get(bookingId);

    return booking === undefined ? undefined : { ...booking };
  }

  domainEventsFor(aggregateId: string): FakeDomainEvent[] {
    return this.domainEvents.filter((event) => event.aggregate_id === aggregateId);
  }

  allDomainEvents(): FakeDomainEvent[] {
    return [...this.domainEvents];
  }

  async initiatePayment(
    input: InitiatePaymentRepositoryInput
  ): Promise<InitiatePaymentRepositoryResult | undefined> {
    const booking = this.bookings.get(input.booking_id);

    if (booking === undefined || booking.explorer_id !== input.explorer_id) {
      return undefined;
    }

    const existing = Array.from(this.payments.values()).find(
      (payment) => payment.idempotency_key === input.booking_id
    );

    if (existing !== undefined) {
      if (existing.status === 'success') {
        return {
          payment: clonePayment(existing),
          gatewayOrder: null,
          alreadyPaid: true
        };
      }

      if (existing.status !== 'initiated') {
        throw new BadRequestException('Booking payment is already terminal');
      }

      return {
        payment: clonePayment(existing),
        gatewayOrder: buildFakeGatewayOrder(existing, booking, input.config.maidanMerchantRef),
        alreadyPaid: false
      };
    }

    if (booking.status !== 'pending') {
      throw new BadRequestException('Booking must be pending to initiate payment');
    }

    if (booking.host_payout_ref === null) {
      throw new BadRequestException('Host payout reference is not configured');
    }

    const split = computePaymentSplit(booking.amount_inr, input.config);
    const payment = newFakePayment({
      booking_id: booking.id,
      phonepe_order_id: input.phonepe_order_id,
      amount_inr: booking.amount_inr,
      platform_fee_inr: split.platform_fee_inr,
      host_payout_inr: split.host_payout_inr,
      status: 'initiated',
      idempotency_key: input.booking_id
    });

    this.payments.set(payment.id, clonePayment(payment));
    booking.payment_id = payment.id;

    return {
      payment: clonePayment(payment),
      gatewayOrder: buildFakeGatewayOrder(payment, booking, input.config.maidanMerchantRef),
      alreadyPaid: false
    };
  }

  async applyTerminalWebhook(
    webhook: VerifiedPaymentWebhook
  ): Promise<PaymentWebhookRepositoryResult | undefined> {
    if (webhook.terminalStatus === 'ignored') {
      return {
        payment: null,
        applied: false,
        terminal_status: 'ignored'
      };
    }

    const payment = Array.from(this.payments.values()).find(
      (candidate) => candidate.phonepe_order_id === webhook.phonepeOrderId
    );

    if (payment === undefined) {
      return undefined;
    }

    if (payment.status === 'success' || payment.status === 'failed' || payment.status === 'refunded') {
      return {
        payment: clonePayment(payment),
        applied: false,
        terminal_status: payment.status
      };
    }

    if (webhook.amountInr !== null && webhook.amountInr !== payment.amount_inr) {
      throw new BadRequestException('PhonePe webhook amount does not match payment amount');
    }

    if (webhook.terminalStatus === 'success') {
      if (webhook.phonepeTxnId === null) {
        throw new BadRequestException('PhonePe success webhook is missing transaction id');
      }

      payment.status = 'success';
      payment.phonepe_txn_id = webhook.phonepeTxnId;
      payment.raw_callback = webhook.raw;
      payment.updated_at = '2026-06-17T08:00:00.000Z';

      const booking = this.bookings.get(payment.booking_id);

      if (booking === undefined) {
        throw new Error('Fake booking missing for payment');
      }

      booking.status = 'confirmed';
      booking.payment_id = payment.id;
      this.domainEvents.push(
        {
          aggregate_type: 'payment',
          aggregate_id: payment.id,
          event_type: 'payment.succeeded',
          payload: {
            payment_id: payment.id,
            booking_id: payment.booking_id,
            phonepe_order_id: payment.phonepe_order_id,
            phonepe_txn_id: payment.phonepe_txn_id,
            amount_inr: payment.amount_inr,
            platform_fee_inr: payment.platform_fee_inr,
            host_payout_inr: payment.host_payout_inr,
            succeeded_at: payment.updated_at
          }
        },
        {
          aggregate_type: 'booking',
          aggregate_id: booking.id,
          event_type: 'booking.confirmed',
          payload: {
            booking_id: booking.id,
            slot_id: booking.slot_id,
            activity_id: booking.activity_id,
            explorer_id: booking.explorer_id,
            host_id: booking.host_id,
            payment_id: payment.id,
            headcount: booking.headcount,
            amount_inr: booking.amount_inr,
            confirmed_at: payment.updated_at
          }
        }
      );

      return {
        payment: clonePayment(payment),
        applied: true,
        terminal_status: 'success'
      };
    }

    payment.status = 'failed';
    payment.raw_callback = webhook.raw;
    payment.updated_at = '2026-06-17T08:00:00.000Z';
    this.domainEvents.push({
      aggregate_type: 'payment',
      aggregate_id: payment.id,
      event_type: 'payment.failed',
      payload: {
        payment_id: payment.id,
        booking_id: payment.booking_id,
        phonepe_order_id: payment.phonepe_order_id,
        amount_inr: payment.amount_inr,
        failure_code: webhook.failureCode,
        failure_reason: webhook.failureReason,
        failed_at: payment.updated_at
      }
    });

    return {
      payment: clonePayment(payment),
      applied: true,
      terminal_status: 'failed'
    };
  }

  async findRefundablePaymentForCancelledBooking(
    bookingId: string
  ): Promise<RefundablePaymentRecord | undefined> {
    const booking = this.bookings.get(bookingId);

    if (booking === undefined || booking.status !== 'cancelled' || booking.payment_id === null) {
      return undefined;
    }

    const payment = this.payments.get(booking.payment_id);

    if (payment === undefined || payment.status !== 'success') {
      return undefined;
    }

    return {
      payment_id: payment.id,
      booking_id: payment.booking_id,
      phonepe_order_id: payment.phonepe_order_id,
      amount_inr: payment.amount_inr
    };
  }

  async markPaymentRefunded(
    paymentId: string,
    refund: PaymentGatewayRefundResult
  ): Promise<PaymentRecord | undefined> {
    const payment = this.payments.get(paymentId);

    if (payment === undefined) {
      return undefined;
    }

    payment.status = 'refunded';
    payment.raw_callback = {
      payment_callback: payment.raw_callback,
      refund: refund.raw
    };

    return clonePayment(payment);
  }
}

describe('Payments module', () => {
  let app: NestFastifyApplication;
  let repository: FakePaymentsRepository;
  let gateway: FakePaymentGateway;

  const explorerProfileId = randomUUID();
  const strangerProfileId = randomUUID();
  const explorerToken = 'explorer-token';
  const strangerToken = 'stranger-token';
  const webhookSecret = 'test-phonepe-webhook-secret';
  const previousWebhookSecret = process.env.PHONEPE_WEBHOOK_SECRET;
  const previousPlatformFeePct = process.env.PLATFORM_FEE_PCT;
  const previousPlatformFeeFloorInr = process.env.PLATFORM_FEE_FLOOR_INR;
  const previousMaidanMerchantRef = process.env.MAIDAN_PHONEPE_MERCHANT_REF;

  beforeAll(async () => {
    process.env.PHONEPE_WEBHOOK_SECRET = webhookSecret;
    process.env.PLATFORM_FEE_PCT = '15';
    process.env.PLATFORM_FEE_FLOOR_INR = '0';
    process.env.MAIDAN_PHONEPE_MERCHANT_REF = 'phonepe-settlement-maidan';

    repository = new FakePaymentsRepository();
    gateway = new FakePaymentGateway();

    const moduleRef = await Test.createTestingModule({
      imports: [PaymentsModule]
    })
      .overrideProvider(AuthService)
      .useValue(
        new FakeAuthService(
          new Map([
            [explorerToken, explorerProfileId],
            [strangerToken, strangerProfileId]
          ])
        )
      )
      .overrideProvider(PAYMENTS_REPOSITORY)
      .useValue(repository)
      .overrideProvider(PAYMENT_GATEWAY)
      .useValue(gateway)
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
  });

  beforeEach(() => {
    repository.reset();
    gateway.createdOrders.length = 0;
    gateway.refunds.length = 0;
  });

  afterAll(async () => {
    restoreEnv('PHONEPE_WEBHOOK_SECRET', previousWebhookSecret);
    restoreEnv('PLATFORM_FEE_PCT', previousPlatformFeePct);
    restoreEnv('PLATFORM_FEE_FLOOR_INR', previousPlatformFeeFloorInr);
    restoreEnv('MAIDAN_PHONEPE_MERCHANT_REF', previousMaidanMerchantRef);
    await app.close();
  });

  it('initiates a split payment, confirms the booking on success webhook, and replays as a no-op', async () => {
    const bookingId = repository.addBooking({
      explorer_id: explorerProfileId,
      amount_inr: 1499
    });
    const initResponse = await app.inject({
      method: 'POST',
      url: '/payments/init',
      headers: {
        authorization: `Bearer ${explorerToken}`
      },
      payload: {
        bookingId
      }
    });
    const initiated = initResponse.json() as InitPaymentResponse;

    expect(initResponse.statusCode).toBe(201);
    expect(initiated.payment).toMatchObject({
      booking_id: bookingId,
      status: 'initiated',
      amount_inr: 1499,
      platform_fee_inr: 225,
      host_payout_inr: 1274,
      idempotency_key: bookingId
    });
    expect(initiated.payment.platform_fee_inr + initiated.payment.host_payout_inr).toBe(
      initiated.payment.amount_inr
    );
    expect(initiated.gateway?.redirectUrl).toBe(
      `https://fake.phonepe.test/pay/${initiated.payment.phonepe_order_id}`
    );
    expect(gateway.createdOrders).toHaveLength(1);
    expect(gateway.createdOrders[0]).toMatchObject({
      bookingId,
      amountInr: 1499,
      split: {
        platform: {
          merchantRef: 'phonepe-settlement-maidan',
          amountInr: 225
        },
        host: {
          payoutRef: 'phonepe-settlement-host',
          amountInr: 1274
        }
      }
    });

    const webhookPayload = successWebhookPayload(initiated.payment.phonepe_order_id, 1499);
    const webhookResponse = await postWebhook(app, webhookPayload);
    const webhookResult = webhookResponse.json() as PaymentWebhookResponse;

    expect(webhookResponse.statusCode).toBe(200);
    expect(webhookResult).toMatchObject({
      received: true,
      applied: true,
      terminal_status: 'success',
      payment: {
        id: initiated.payment.id,
        status: 'success',
        phonepe_txn_id: 'TXN-SUCCESS-001'
      }
    });
    expect(repository.getBooking(bookingId)).toMatchObject({
      status: 'confirmed',
      payment_id: initiated.payment.id
    });
    expect(repository.domainEventsFor(initiated.payment.id)).toEqual([
      expect.objectContaining({
        aggregate_type: 'payment',
        event_type: 'payment.succeeded'
      })
    ]);
    expect(repository.domainEventsFor(bookingId)).toEqual([
      expect.objectContaining({
        aggregate_type: 'booking',
        event_type: 'booking.confirmed'
      })
    ]);

    const eventCountAfterFirstWebhook = repository.allDomainEvents().length;
    const replayResponse = await postWebhook(app, webhookPayload);
    const replayResult = replayResponse.json() as PaymentWebhookResponse;

    expect(replayResponse.statusCode).toBe(200);
    expect(replayResult).toMatchObject({
      received: true,
      applied: false,
      terminal_status: 'success'
    });
    expect(repository.allDomainEvents()).toHaveLength(eventCountAfterFirstWebhook);
  });

  it('keeps split amounts reconciled for initiated payments', async () => {
    for (const amountInr of [100, 299, 1000, 2400]) {
      const bookingId = repository.addBooking({
        explorer_id: explorerProfileId,
        amount_inr: amountInr
      });
      const response = await app.inject({
        method: 'POST',
        url: '/payments/init',
        headers: {
          authorization: `Bearer ${explorerToken}`
        },
        payload: {
          bookingId
        }
      });
      const body = response.json() as InitPaymentResponse;

      expect(response.statusCode).toBe(201);
      expect(body.payment.platform_fee_inr + body.payment.host_payout_inr).toBe(amountInr);
    }
  });

  it('rejects webhook requests with an invalid signature', async () => {
    const bookingId = repository.addBooking({
      explorer_id: explorerProfileId,
      amount_inr: 1000
    });
    const initResponse = await app.inject({
      method: 'POST',
      url: '/payments/init',
      headers: {
        authorization: `Bearer ${explorerToken}`
      },
      payload: {
        bookingId
      }
    });
    const initiated = initResponse.json() as InitPaymentResponse;
    const response = await app.inject({
      method: 'POST',
      url: '/payments/webhook',
      headers: {
        authorization: 'invalid-signature'
      },
      payload: successWebhookPayload(initiated.payment.phonepe_order_id, 1000)
    });

    expect(response.statusCode).toBe(401);
    expect(repository.getBooking(bookingId)).toMatchObject({
      status: 'pending'
    });
  });

  it('does not let another explorer initiate payment for someone else’s booking', async () => {
    const bookingId = repository.addBooking({
      explorer_id: explorerProfileId,
      amount_inr: 1000
    });
    const response = await app.inject({
      method: 'POST',
      url: '/payments/init',
      headers: {
        authorization: `Bearer ${strangerToken}`
      },
      payload: {
        bookingId
      }
    });

    expect(response.statusCode).toBe(404);
  });
});

function buildFakeGatewayOrder(
  payment: PaymentRecord,
  booking: FakeBooking,
  maidanMerchantRef: string
): PaymentGatewayCreateOrderInput {
  if (booking.host_payout_ref === null) {
    throw new BadRequestException('Host payout reference is not configured');
  }

  return {
    bookingId: booking.id,
    phonepeOrderId: payment.phonepe_order_id,
    amountInr: payment.amount_inr,
    split: {
      platform: {
        merchantRef: maidanMerchantRef,
        amountInr: payment.platform_fee_inr
      },
      host: {
        payoutRef: booking.host_payout_ref,
        amountInr: payment.host_payout_inr
      }
    }
  };
}

function newFakePayment(input: {
  booking_id: string;
  phonepe_order_id: string;
  amount_inr: number;
  platform_fee_inr: number;
  host_payout_inr: number;
  status: PaymentStatus;
  idempotency_key: string;
}): PaymentRecord {
  const timestamp = '2026-06-17T07:00:00.000Z';

  return {
    id: randomUUID(),
    booking_id: input.booking_id,
    phonepe_order_id: input.phonepe_order_id,
    phonepe_txn_id: null,
    amount_inr: input.amount_inr,
    platform_fee_inr: input.platform_fee_inr,
    host_payout_inr: input.host_payout_inr,
    status: input.status,
    idempotency_key: input.idempotency_key,
    raw_callback: null,
    created_at: timestamp,
    updated_at: timestamp
  };
}

function successWebhookPayload(phonepeOrderId: string, amountInr: number): Record<string, unknown> {
  return {
    event: 'checkout.order.completed',
    payload: {
      orderId: `OMO-${phonepeOrderId}`,
      merchantId: 'phonepe-settlement-maidan',
      merchantOrderId: phonepeOrderId,
      state: 'COMPLETED',
      amount: amountInr * 100,
      paymentDetails: [
        {
          paymentMode: 'UPI_INTENT',
          timestamp: 1_718_015_600_000,
          amount: amountInr * 100,
          transactionId: 'TXN-SUCCESS-001',
          state: 'COMPLETED'
        }
      ],
      metaInfo: {
        udf1: 'test'
      }
    }
  };
}

async function postWebhook(app: NestFastifyApplication, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/payments/webhook',
    headers: {
      authorization: createPhonePeWebhookAuthorizationFromSecret('test-phonepe-webhook-secret')
    },
    payload
  });
}

function clonePayment(payment: PaymentRecord): PaymentRecord {
  return {
    ...payment,
    raw_callback: payment.raw_callback === null ? null : { ...payment.raw_callback }
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
