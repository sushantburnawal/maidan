import {
  BadRequestException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  OnModuleDestroy
} from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';

import type {
  BookingCancelledPayload,
  BookingCreatedPayload,
  BookingStatus,
  SlotStatus
} from '@maidan/shared';
import { withCurrentCorrelation } from '../observability/request-context';
import { CANCELLABLE_BOOKING_STATUSES } from './bookings.constants';
import type { BookingRecord, BookingsRepository, CreateBookingInput } from './bookings.types';

interface BookingRow {
  id: string;
  slot_id: string;
  explorer_id: string;
  headcount: number;
  amount_inr: number;
  status: BookingStatus;
  payment_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface BookableSlotRow {
  id: string;
  activity_id: string;
  starts_at: Date | string;
  capacity: number;
  booked_count: number;
  status: SlotStatus;
  host_id: string;
  base_price_inr: number;
}

interface CancelableBookingRow extends BookingRow {
  activity_id: string;
  slot_starts_at: Date | string;
  slot_status: SlotStatus;
  host_id: string;
}

@Injectable()
export class PostgresBookingsRepository implements BookingsRepository, OnModuleDestroy {
  private pool: Pool | undefined;

  async createBooking(
    explorerId: string,
    input: CreateBookingInput
  ): Promise<BookingRecord | undefined> {
    return this.withTransaction(async (client) => {
      if (input.headcount <= 0) {
        throw new BadRequestException('headcount must be positive');
      }

      const slotResult = await client.query<BookableSlotRow>(
        `
          select
            s.id,
            s.activity_id,
            s.starts_at,
            s.capacity,
            s.booked_count,
            s.status,
            a.host_id,
            a.base_price_inr
          from activity_slots s
          join activities a on a.id = s.activity_id
          where s.id = $1
          for update of s
        `,
        [input.slot_id]
      );
      const slot = slotResult.rows[0];

      if (slot === undefined) {
        return undefined;
      }

      if (slot.status !== 'open') {
        throw new BadRequestException('Slot is not open for booking');
      }

      if (slot.booked_count + input.headcount > slot.capacity) {
        throw new BadRequestException('Slot capacity exceeded');
      }

      const amountInr = slot.base_price_inr * input.headcount;
      const bookingResult = await client.query<BookingRow>(
        `
          insert into bookings (slot_id, explorer_id, headcount, amount_inr, status)
          values ($1, $2, $3, $4, 'pending'::booking_status)
          returning ${bookingColumns()}
        `,
        [slot.id, explorerId, input.headcount, amountInr]
      );
      const booking = mapReturnedBooking(bookingResult.rows[0]);

      await client.query(
        `
          update activity_slots
          set booked_count = booked_count + $2,
              status = case
                when booked_count + $2 = capacity then 'full'::slot_status
                else status
              end
          where id = $1
        `,
        [slot.id, input.headcount]
      );

      await insertBookingCreatedEvent(client, booking, slot);

      return booking;
    }, 'Failed to create booking');
  }

  async cancelBooking(bookingId: string, explorerId: string): Promise<BookingRecord | undefined> {
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<CancelableBookingRow>(
        `
          select
            ${bookingColumns('b')},
            s.activity_id,
            s.starts_at as slot_starts_at,
            s.status as slot_status,
            a.host_id
          from bookings b
          join activity_slots s on s.id = b.slot_id
          join activities a on a.id = s.activity_id
          where b.id = $1
            and b.explorer_id = $2
          for update of b, s
        `,
        [bookingId, explorerId]
      );
      const current = currentResult.rows[0];

      if (current === undefined) {
        return undefined;
      }

      if (!isCancellableStatus(current.status)) {
        throw new BadRequestException('Booking cannot be cancelled');
      }

      if (new Date(current.slot_starts_at).getTime() <= Date.now()) {
        throw new BadRequestException('Cannot cancel a booking after the slot has started');
      }

      const previousStatus = current.status;
      const bookingResult = await client.query<BookingRow>(
        `
          update bookings
          set status = 'cancelled'::booking_status
          where id = $1
          returning ${bookingColumns()}
        `,
        [bookingId]
      );
      const booking = mapReturnedBooking(bookingResult.rows[0]);

      await client.query(
        `
          update activity_slots
          set booked_count = booked_count - $2,
              status = case
                when status = 'full'::slot_status then 'open'::slot_status
                else status
              end
          where id = $1
        `,
        [current.slot_id, current.headcount]
      );

      await insertBookingCancelledEvent(client, booking, current, previousStatus);

      return booking;
    }, 'Failed to cancel booking');
  }

  async findExplorerBookings(explorerId: string): Promise<BookingRecord[]> {
    try {
      const result = await this.getPool().query<BookingRow>(
        `
          select ${bookingColumns('b')}
          from bookings b
          where b.explorer_id = $1
          order by b.created_at desc
        `,
        [explorerId]
      );

      return result.rows.map(mapRequiredBooking);
    } catch (error) {
      throw toRepositoryError(error, 'Failed to read explorer bookings');
    }
  }

  async findActivityBookings(
    activityId: string,
    hostId: string
  ): Promise<BookingRecord[] | undefined> {
    try {
      const activityResult = await this.getPool().query<{ id: string }>(
        `
          select id
          from activities
          where id = $1
            and host_id = $2
        `,
        [activityId, hostId]
      );

      if (activityResult.rows[0] === undefined) {
        return undefined;
      }

      const bookingsResult = await this.getPool().query<BookingRow>(
        `
          select ${bookingColumns('b')}
          from bookings b
          join activity_slots s on s.id = b.slot_id
          where s.activity_id = $1
          order by s.starts_at asc, b.created_at asc
        `,
        [activityId]
      );

      return bookingsResult.rows.map(mapRequiredBooking);
    } catch (error) {
      throw toRepositoryError(error, 'Failed to read activity bookings');
    }
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

function bookingColumns(alias?: string): string {
  const prefix = alias === undefined ? '' : `${alias}.`;

  return `
    ${prefix}id,
    ${prefix}slot_id,
    ${prefix}explorer_id,
    ${prefix}headcount,
    ${prefix}amount_inr,
    ${prefix}status,
    ${prefix}payment_id,
    ${prefix}created_at,
    ${prefix}updated_at
  `;
}

async function insertBookingCreatedEvent(
  client: PoolClient,
  booking: BookingRecord,
  slot: BookableSlotRow
): Promise<void> {
  const payload: BookingCreatedPayload = {
    booking_id: booking.id,
    slot_id: booking.slot_id,
    activity_id: slot.activity_id,
    explorer_id: booking.explorer_id,
    host_id: slot.host_id,
    headcount: booking.headcount,
    amount_inr: booking.amount_inr,
    created_at: booking.created_at
  };

  await insertDomainEvent(client, booking.id, 'booking.created', payload);
}

async function insertBookingCancelledEvent(
  client: PoolClient,
  booking: BookingRecord,
  current: CancelableBookingRow,
  previousStatus: BookingStatus
): Promise<void> {
  const payload: BookingCancelledPayload = {
    booking_id: booking.id,
    slot_id: booking.slot_id,
    activity_id: current.activity_id,
    explorer_id: booking.explorer_id,
    host_id: current.host_id,
    payment_id: booking.payment_id,
    previous_status: previousStatus,
    headcount: booking.headcount,
    amount_inr: booking.amount_inr,
    cancelled_at: booking.updated_at
  };

  await insertDomainEvent(client, booking.id, 'booking.cancelled', payload);
}

async function insertDomainEvent(
  client: PoolClient,
  aggregateId: string,
  eventType: 'booking.created' | 'booking.cancelled',
  payload: BookingCreatedPayload | BookingCancelledPayload
): Promise<void> {
  await client.query(
    `
      insert into domain_events (aggregate_type, aggregate_id, event_type, payload)
      values ('booking', $1, $2, $3::jsonb)
    `,
    [aggregateId, eventType, JSON.stringify(withCurrentCorrelation(payload))]
  );
}

function mapRequiredBooking(row: BookingRow): BookingRecord {
  return {
    id: row.id,
    slot_id: row.slot_id,
    explorer_id: row.explorer_id,
    headcount: row.headcount,
    amount_inr: row.amount_inr,
    status: row.status,
    payment_id: row.payment_id,
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at)
  };
}

function mapReturnedBooking(row: BookingRow | undefined): BookingRecord {
  if (row === undefined) {
    throw new InternalServerErrorException('Booking row was not returned');
  }

  return mapRequiredBooking(row);
}

function isCancellableStatus(status: BookingStatus): boolean {
  return CANCELLABLE_BOOKING_STATUSES.some((cancellableStatus) => cancellableStatus === status);
}

function toIsoTimestamp(value: Date | string): string {
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
