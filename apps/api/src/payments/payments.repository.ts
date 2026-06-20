import {
  BadRequestException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  OnModuleDestroy
} from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';

import type {
  BookingConfirmedPayload,
  BookingStatus,
  PaymentFailedPayload,
  PaymentStatus,
  PaymentSucceededPayload
} from '@maidan/shared';
import type {
  PaymentGatewayCreateOrderInput,
  PaymentGatewayRefundResult,
  VerifiedPaymentWebhook
} from './payment-gateway';
import { withCurrentCorrelation } from '../observability/request-context';
import { TERMINAL_PAYMENT_STATUSES } from './payments.constants';
import { computePaymentSplit } from './payments.splits';
import type {
  InitiatePaymentRepositoryInput,
  InitiatePaymentRepositoryResult,
  PaymentRecord,
  PaymentsRepository,
  PaymentWebhookRepositoryResult,
  RefundablePaymentRecord
} from './payments.types';

interface PaymentRow {
  id: string;
  booking_id: string;
  phonepe_order_id: string;
  phonepe_txn_id: string | null;
  amount_inr: number;
  platform_fee_inr: number;
  host_payout_inr: number;
  status: PaymentStatus;
  idempotency_key: string;
  raw_callback: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PaymentInitContextRow {
  booking_id: string;
  slot_id: string;
  activity_id: string;
  explorer_id: string;
  host_id: string;
  host_payout_ref: string | null;
  headcount: number;
  amount_inr: number;
  booking_status: BookingStatus;
  payment_id: string | null;
}

interface PaymentWebhookContextRow extends PaymentRow {
  slot_id: string;
  activity_id: string;
  explorer_id: string;
  host_id: string;
  headcount: number;
  booking_amount_inr: number;
  booking_status: BookingStatus;
}

@Injectable()
export class PostgresPaymentsRepository implements PaymentsRepository, OnModuleDestroy {
  private pool: Pool | undefined;

  async initiatePayment(
    input: InitiatePaymentRepositoryInput
  ): Promise<InitiatePaymentRepositoryResult | undefined> {
    return this.withTransaction(async (client) => {
      const context = await findPaymentInitContext(client, input.booking_id, input.explorer_id);

      if (context === undefined) {
        return undefined;
      }

      const existingPayment = await findPaymentByIdempotencyKey(client, input.booking_id);

      if (existingPayment !== undefined) {
        if (existingPayment.status === 'success') {
          return {
            payment: existingPayment,
            gatewayOrder: null,
            alreadyPaid: true
          };
        }

        if (existingPayment.status !== 'initiated') {
          throw new BadRequestException('Booking payment is already terminal');
        }

        assertBookingCanBePaid(context);

        return {
          payment: existingPayment,
          gatewayOrder: buildGatewayOrder(existingPayment, context, input.config.maidanMerchantRef),
          alreadyPaid: false
        };
      }

      assertBookingCanBePaid(context);

      const split = computePaymentSplit(context.amount_inr, input.config);
      const paymentResult = await client.query<PaymentRow>(
        `
          insert into payments (
            booking_id,
            phonepe_order_id,
            amount_inr,
            platform_fee_inr,
            host_payout_inr,
            status,
            idempotency_key
          )
          values ($1, $2, $3, $4, $5, 'initiated'::payment_status, $6)
          returning ${paymentColumns()}
        `,
        [
          context.booking_id,
          input.phonepe_order_id,
          context.amount_inr,
          split.platform_fee_inr,
          split.host_payout_inr,
          input.booking_id
        ]
      );
      const payment = mapReturnedPayment(paymentResult.rows[0]);

      await client.query(
        `
          update bookings
          set payment_id = $2
          where id = $1
        `,
        [context.booking_id, payment.id]
      );

      return {
        payment,
        gatewayOrder: buildGatewayOrder(payment, context, input.config.maidanMerchantRef),
        alreadyPaid: false
      };
    }, 'Failed to initiate payment');
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

    return this.withTransaction(async (client) => {
      const context = await findWebhookContext(client, webhook.phonepeOrderId);

      if (context === undefined) {
        return undefined;
      }

      const existingPayment = mapRequiredPayment(context);

      if (isTerminalPaymentStatus(existingPayment.status)) {
        return {
          payment: existingPayment,
          applied: false,
          terminal_status: existingPayment.status
        };
      }

      if (webhook.amountInr !== null && webhook.amountInr !== existingPayment.amount_inr) {
        throw new BadRequestException('PhonePe webhook amount does not match payment amount');
      }

      if (webhook.terminalStatus === 'success') {
        const payment = await markPaymentSucceeded(client, existingPayment, context, webhook);

        return {
          payment,
          applied: true,
          terminal_status: 'success'
        };
      }

      const payment = await markPaymentFailed(client, existingPayment, webhook);

      return {
        payment,
        applied: true,
        terminal_status: 'failed'
      };
    }, 'Failed to apply PhonePe webhook');
  }

  async findRefundablePaymentForCancelledBooking(
    bookingId: string
  ): Promise<RefundablePaymentRecord | undefined> {
    try {
      const result = await this.getPool().query<RefundablePaymentRecord>(
        `
          select
            p.id as payment_id,
            p.booking_id,
            p.phonepe_order_id,
            p.amount_inr
          from payments p
          join bookings b on b.id = p.booking_id
          where b.id = $1
            and b.status = 'cancelled'::booking_status
            and p.status = 'success'::payment_status
            and b.payment_id = p.id
          order by p.updated_at desc
          limit 1
        `,
        [bookingId]
      );

      return result.rows[0];
    } catch (error) {
      throw toRepositoryError(error, 'Failed to read refundable payment');
    }
  }

  async markPaymentRefunded(
    paymentId: string,
    refund: PaymentGatewayRefundResult
  ): Promise<PaymentRecord | undefined> {
    return this.withTransaction(async (client) => {
      const existingResult = await client.query<PaymentRow>(
        `
          select ${paymentColumns('p')}
          from payments p
          where p.id = $1
          for update of p
        `,
        [paymentId]
      );
      const existing = existingResult.rows[0];

      if (existing === undefined) {
        return undefined;
      }

      if (existing.status === 'refunded') {
        return mapRequiredPayment(existing);
      }

      if (existing.status !== 'success') {
        throw new BadRequestException('Only successful payments can be refunded');
      }

      const result = await client.query<PaymentRow>(
        `
          update payments
          set status = 'refunded'::payment_status,
              raw_callback = jsonb_build_object(
                'payment_callback',
                raw_callback,
                'refund',
                $2::jsonb
              )
          where id = $1
          returning ${paymentColumns()}
        `,
        [paymentId, JSON.stringify(refund.raw)]
      );

      return mapReturnedPayment(result.rows[0]);
    }, 'Failed to mark payment refunded');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool !== undefined) {
      await this.pool.end();
    }
  }

  private async withTransaction<T>(
    operation: (client: PoolClient) => Promise<T>,
    errorMessage: string
  ): Promise<T> {
    const client = await this.getPool().connect();

    try {
      await client.query('begin');
      const result = await operation(client);
      await client.query('commit');

      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw toRepositoryError(error, errorMessage);
    } finally {
      client.release();
    }
  }

  private getPool(): Pool {
    if (this.pool !== undefined) {
      return this.pool;
    }

    const connectionString = process.env.DATABASE_URL;

    if (connectionString === undefined || connectionString.length === 0) {
      throw new InternalServerErrorException('DATABASE_URL is not configured');
    }

    this.pool = new Pool({
      connectionString,
      ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : undefined
    });

    return this.pool;
  }
}

async function findPaymentInitContext(
  client: PoolClient,
  bookingId: string,
  explorerId: string
): Promise<PaymentInitContextRow | undefined> {
  const result = await client.query<PaymentInitContextRow>(
    `
      select
        b.id as booking_id,
        b.slot_id,
        s.activity_id,
        b.explorer_id,
        a.host_id,
        hp.payout_ref as host_payout_ref,
        b.headcount,
        b.amount_inr,
        b.status as booking_status,
        b.payment_id
      from bookings b
      join activity_slots s on s.id = b.slot_id
      join activities a on a.id = s.activity_id
      left join host_profiles hp on hp.profile_id = a.host_id
      where b.id = $1
        and b.explorer_id = $2
      for update of b
    `,
    [bookingId, explorerId]
  );

  return result.rows[0];
}

async function findPaymentByIdempotencyKey(
  client: PoolClient,
  idempotencyKey: string
): Promise<PaymentRecord | undefined> {
  const result = await client.query<PaymentRow>(
    `
      select ${paymentColumns('p')}
      from payments p
      where p.idempotency_key = $1
      for update of p
    `,
    [idempotencyKey]
  );
  const row = result.rows[0];

  return row === undefined ? undefined : mapRequiredPayment(row);
}

async function findWebhookContext(
  client: PoolClient,
  phonepeOrderId: string
): Promise<PaymentWebhookContextRow | undefined> {
  const result = await client.query<PaymentWebhookContextRow>(
    `
      select
        ${paymentColumns('p')},
        b.slot_id,
        s.activity_id,
        b.explorer_id,
        a.host_id,
        b.headcount,
        b.amount_inr as booking_amount_inr,
        b.status as booking_status
      from payments p
      join bookings b on b.id = p.booking_id
      join activity_slots s on s.id = b.slot_id
      join activities a on a.id = s.activity_id
      where p.phonepe_order_id = $1
      for update of p, b
    `,
    [phonepeOrderId]
  );

  return result.rows[0];
}

async function markPaymentSucceeded(
  client: PoolClient,
  payment: PaymentRecord,
  context: PaymentWebhookContextRow,
  webhook: VerifiedPaymentWebhook
): Promise<PaymentRecord> {
  if (webhook.phonepeTxnId === null) {
    throw new BadRequestException('PhonePe success webhook is missing transaction id');
  }

  const paymentResult = await client.query<PaymentRow>(
    `
      update payments
      set status = 'success'::payment_status,
          phonepe_txn_id = $2,
          raw_callback = $3::jsonb
      where id = $1
      returning ${paymentColumns()}
    `,
    [payment.id, webhook.phonepeTxnId, JSON.stringify(webhook.raw)]
  );
  const updatedPayment = mapReturnedPayment(paymentResult.rows[0]);
  const bookingResult = await client.query<{ updated_at: Date | string }>(
    `
      update bookings
      set status = 'confirmed'::booking_status,
          payment_id = $2
      where id = $1
      returning updated_at
    `,
    [payment.booking_id, payment.id]
  );
  const confirmedAt = toIsoTimestamp(bookingResult.rows[0]?.updated_at);

  await insertPaymentSucceededEvent(client, updatedPayment, confirmedAt);
  await insertBookingConfirmedEvent(client, context, updatedPayment, confirmedAt);

  return updatedPayment;
}

async function markPaymentFailed(
  client: PoolClient,
  payment: PaymentRecord,
  webhook: VerifiedPaymentWebhook
): Promise<PaymentRecord> {
  const paymentResult = await client.query<PaymentRow>(
    `
      update payments
      set status = 'failed'::payment_status,
          phonepe_txn_id = $2,
          raw_callback = $3::jsonb
      where id = $1
      returning ${paymentColumns()}
    `,
    [payment.id, webhook.phonepeTxnId, JSON.stringify(webhook.raw)]
  );
  const updatedPayment = mapReturnedPayment(paymentResult.rows[0]);

  await insertPaymentFailedEvent(client, updatedPayment, webhook);

  return updatedPayment;
}

async function insertPaymentSucceededEvent(
  client: PoolClient,
  payment: PaymentRecord,
  succeededAt: string
): Promise<void> {
  if (payment.phonepe_txn_id === null) {
    throw new InternalServerErrorException('Successful payment is missing PhonePe transaction id');
  }

  const payload: PaymentSucceededPayload = {
    payment_id: payment.id,
    booking_id: payment.booking_id,
    phonepe_order_id: payment.phonepe_order_id,
    phonepe_txn_id: payment.phonepe_txn_id,
    amount_inr: payment.amount_inr,
    platform_fee_inr: payment.platform_fee_inr,
    host_payout_inr: payment.host_payout_inr,
    succeeded_at: succeededAt
  };

  await insertDomainEvent(client, 'payment', payment.id, 'payment.succeeded', payload);
}

async function insertBookingConfirmedEvent(
  client: PoolClient,
  context: PaymentWebhookContextRow,
  payment: PaymentRecord,
  confirmedAt: string
): Promise<void> {
  const payload: BookingConfirmedPayload = {
    booking_id: payment.booking_id,
    slot_id: context.slot_id,
    activity_id: context.activity_id,
    explorer_id: context.explorer_id,
    host_id: context.host_id,
    payment_id: payment.id,
    headcount: context.headcount,
    amount_inr: context.booking_amount_inr,
    confirmed_at: confirmedAt
  };

  await insertDomainEvent(client, 'booking', payment.booking_id, 'booking.confirmed', payload);
}

async function insertPaymentFailedEvent(
  client: PoolClient,
  payment: PaymentRecord,
  webhook: VerifiedPaymentWebhook
): Promise<void> {
  const payload: PaymentFailedPayload = {
    payment_id: payment.id,
    booking_id: payment.booking_id,
    phonepe_order_id: payment.phonepe_order_id,
    amount_inr: payment.amount_inr,
    failure_code: webhook.failureCode ?? undefined,
    failure_reason: webhook.failureReason ?? undefined,
    failed_at: payment.updated_at
  };

  await insertDomainEvent(client, 'payment', payment.id, 'payment.failed', payload);
}

async function insertDomainEvent(
  client: PoolClient,
  aggregateType: 'booking' | 'payment',
  aggregateId: string,
  eventType: 'booking.confirmed' | 'payment.succeeded' | 'payment.failed',
  payload: BookingConfirmedPayload | PaymentSucceededPayload | PaymentFailedPayload
): Promise<void> {
  await client.query(
    `
      insert into domain_events (aggregate_type, aggregate_id, event_type, payload)
      values ($1, $2, $3, $4::jsonb)
    `,
    [aggregateType, aggregateId, eventType, JSON.stringify(withCurrentCorrelation(payload))]
  );
}

function buildGatewayOrder(
  payment: PaymentRecord,
  context: PaymentInitContextRow,
  maidanMerchantRef: string
): PaymentGatewayCreateOrderInput {
  const hostPayoutRef = context.host_payout_ref;

  if (hostPayoutRef === null || hostPayoutRef.length === 0) {
    throw new BadRequestException('Host payout reference is not configured');
  }

  if (payment.platform_fee_inr + payment.host_payout_inr !== payment.amount_inr) {
    throw new BadRequestException('Payment split does not reconcile to booking amount');
  }

  return {
    bookingId: payment.booking_id,
    phonepeOrderId: payment.phonepe_order_id,
    amountInr: payment.amount_inr,
    split: {
      platform: {
        merchantRef: maidanMerchantRef,
        amountInr: payment.platform_fee_inr
      },
      host: {
        payoutRef: hostPayoutRef,
        amountInr: payment.host_payout_inr
      }
    }
  };
}

function assertBookingCanBePaid(context: PaymentInitContextRow): void {
  if (context.booking_status !== 'pending') {
    throw new BadRequestException('Booking must be pending to initiate payment');
  }

  if (context.amount_inr <= 0) {
    throw new BadRequestException('Booking amount must be positive to initiate payment');
  }

  if (context.host_payout_ref === null || context.host_payout_ref.length === 0) {
    throw new BadRequestException('Host payout reference is not configured');
  }
}

function paymentColumns(alias?: string): string {
  const prefix = alias === undefined ? '' : `${alias}.`;

  return `
    ${prefix}id,
    ${prefix}booking_id,
    ${prefix}phonepe_order_id,
    ${prefix}phonepe_txn_id,
    ${prefix}amount_inr,
    ${prefix}platform_fee_inr,
    ${prefix}host_payout_inr,
    ${prefix}status,
    ${prefix}idempotency_key,
    ${prefix}raw_callback,
    ${prefix}created_at,
    ${prefix}updated_at
  `;
}

function mapReturnedPayment(row: PaymentRow | undefined): PaymentRecord {
  if (row === undefined) {
    throw new InternalServerErrorException('Payment row was not returned');
  }

  return mapRequiredPayment(row);
}

function mapRequiredPayment(row: PaymentRow): PaymentRecord {
  return {
    id: row.id,
    booking_id: row.booking_id,
    phonepe_order_id: row.phonepe_order_id,
    phonepe_txn_id: row.phonepe_txn_id,
    amount_inr: row.amount_inr,
    platform_fee_inr: row.platform_fee_inr,
    host_payout_inr: row.host_payout_inr,
    status: row.status,
    idempotency_key: row.idempotency_key,
    raw_callback: row.raw_callback,
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at)
  };
}

function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return TERMINAL_PAYMENT_STATUSES.some((terminalStatus) => terminalStatus === status);
}

function toIsoTimestamp(value: Date | string | undefined): string {
  if (value === undefined) {
    throw new InternalServerErrorException('Timestamp was not returned');
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value).toISOString();
}

function toRepositoryError(error: unknown, message: string): HttpException {
  if (error instanceof HttpException) {
    return error;
  }

  return new InternalServerErrorException(message);
}
