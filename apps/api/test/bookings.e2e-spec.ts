import { BadRequestException, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import { AuthService } from '../src/auth/auth.service';
import type { AuthenticatedUser } from '../src/auth/auth.types';
import {
  BOOKINGS_REPOSITORY,
  RESPONSIBLE_CANCELLATION_NOTE
} from '../src/bookings/bookings.constants';
import { BookingsModule } from '../src/bookings/bookings.module';
import type {
  BookingRecord,
  BookingsRepository,
  CancelBookingResponse,
  CreateBookingInput,
  CreateBookingResponse
} from '../src/bookings/bookings.types';

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

interface FakeActivity {
  id: string;
  host_id: string;
  base_price_inr: number;
}

interface FakeSlot {
  id: string;
  activity_id: string;
  starts_at: string;
  capacity: number;
  booked_count: number;
  status: 'open' | 'full' | 'closed' | 'cancelled';
}

interface FakeDomainEvent {
  aggregate_type: 'booking';
  aggregate_id: string;
  event_type: 'booking.created' | 'booking.cancelled';
  payload: Record<string, unknown>;
}

class FakeBookingsRepository implements BookingsRepository {
  private readonly activities = new Map<string, FakeActivity>();
  private readonly slots = new Map<string, FakeSlot>();
  private readonly bookings = new Map<string, BookingRecord>();
  private readonly slotLocks = new Map<string, Promise<void>>();
  private readonly domainEvents: FakeDomainEvent[] = [];

  reset(): void {
    this.activities.clear();
    this.slots.clear();
    this.bookings.clear();
    this.slotLocks.clear();
    this.domainEvents.length = 0;
  }

  addActivity(input: { host_id: string; base_price_inr: number }): string {
    const id = randomUUID();

    this.activities.set(id, {
      id,
      host_id: input.host_id,
      base_price_inr: input.base_price_inr
    });

    return id;
  }

  addSlot(
    activityId: string,
    input: { starts_at?: string; capacity: number; status?: FakeSlot['status'] }
  ): string {
    const id = randomUUID();

    this.slots.set(id, {
      id,
      activity_id: activityId,
      starts_at: input.starts_at ?? '2030-01-05T00:30:00.000Z',
      capacity: input.capacity,
      booked_count: 0,
      status: input.status ?? 'open'
    });

    return id;
  }

  getSlot(slotId: string): FakeSlot | undefined {
    const slot = this.slots.get(slotId);

    return slot === undefined ? undefined : { ...slot };
  }

  domainEventsFor(bookingId: string): FakeDomainEvent[] {
    return this.domainEvents.filter((event) => event.aggregate_id === bookingId);
  }

  async createBooking(
    explorerId: string,
    input: CreateBookingInput
  ): Promise<BookingRecord | undefined> {
    await nextTick();

    return this.withSlotLock(input.slot_id, async () => {
      const slot = this.slots.get(input.slot_id);

      if (slot === undefined) {
        return undefined;
      }

      if (slot.status !== 'open') {
        throw new BadRequestException('Slot is not open for booking');
      }

      if (slot.booked_count + input.headcount > slot.capacity) {
        throw new BadRequestException('Slot capacity exceeded');
      }

      const activity = this.activities.get(slot.activity_id);

      if (activity === undefined) {
        throw new Error('Fake activity missing for slot');
      }

      const booking = this.newBooking({
        slot_id: slot.id,
        explorer_id: explorerId,
        headcount: input.headcount,
        amount_inr: activity.base_price_inr * input.headcount,
        status: 'pending'
      });

      this.bookings.set(booking.id, cloneBooking(booking));
      slot.booked_count += input.headcount;
      slot.status = slot.booked_count === slot.capacity ? 'full' : slot.status;
      this.domainEvents.push({
        aggregate_type: 'booking',
        aggregate_id: booking.id,
        event_type: 'booking.created',
        payload: {
          booking_id: booking.id,
          slot_id: slot.id,
          activity_id: activity.id,
          explorer_id: explorerId,
          host_id: activity.host_id,
          headcount: booking.headcount,
          amount_inr: booking.amount_inr,
          created_at: booking.created_at
        }
      });

      return cloneBooking(booking);
    });
  }

  async cancelBooking(bookingId: string, explorerId: string): Promise<BookingRecord | undefined> {
    const candidate = this.bookings.get(bookingId);

    if (candidate === undefined || candidate.explorer_id !== explorerId) {
      return undefined;
    }

    return this.withSlotLock(candidate.slot_id, async () => {
      const booking = this.bookings.get(bookingId);

      if (booking === undefined || booking.explorer_id !== explorerId) {
        return undefined;
      }

      if (booking.status !== 'pending' && booking.status !== 'confirmed') {
        throw new BadRequestException('Booking cannot be cancelled');
      }

      const slot = this.slots.get(booking.slot_id);

      if (slot === undefined) {
        throw new Error('Fake slot missing for booking');
      }

      if (new Date(slot.starts_at).getTime() <= Date.now()) {
        throw new BadRequestException('Cannot cancel a booking after the slot has started');
      }

      const activity = this.activities.get(slot.activity_id);

      if (activity === undefined) {
        throw new Error('Fake activity missing for slot');
      }

      const previousStatus = booking.status;
      const cancelledBooking: BookingRecord = {
        ...booking,
        status: 'cancelled',
        updated_at: '2026-06-17T07:15:00.000Z'
      };

      this.bookings.set(bookingId, cloneBooking(cancelledBooking));
      slot.booked_count -= booking.headcount;

      if (slot.status === 'full') {
        slot.status = 'open';
      }

      this.domainEvents.push({
        aggregate_type: 'booking',
        aggregate_id: booking.id,
        event_type: 'booking.cancelled',
        payload: {
          booking_id: booking.id,
          slot_id: slot.id,
          activity_id: activity.id,
          explorer_id: explorerId,
          host_id: activity.host_id,
          payment_id: booking.payment_id,
          previous_status: previousStatus,
          headcount: booking.headcount,
          amount_inr: booking.amount_inr,
          cancelled_at: cancelledBooking.updated_at
        }
      });

      return cloneBooking(cancelledBooking);
    });
  }

  async findExplorerBookings(explorerId: string): Promise<BookingRecord[]> {
    return Array.from(this.bookings.values())
      .filter((booking) => booking.explorer_id === explorerId)
      .map(cloneBooking);
  }

  async findActivityBookings(
    activityId: string,
    hostId: string
  ): Promise<BookingRecord[] | undefined> {
    const activity = this.activities.get(activityId);

    if (activity === undefined || activity.host_id !== hostId) {
      return undefined;
    }

    const slotIds = new Set(
      Array.from(this.slots.values())
        .filter((slot) => slot.activity_id === activityId)
        .map((slot) => slot.id)
    );

    return Array.from(this.bookings.values())
      .filter((booking) => slotIds.has(booking.slot_id))
      .map(cloneBooking);
  }

  private async withSlotLock<T>(slotId: string, operation: () => Promise<T>): Promise<T> {
    const previousLock = this.slotLocks.get(slotId) ?? Promise.resolve();
    let releaseCurrentLock!: () => void;
    const currentLock = new Promise<void>((resolve) => {
      releaseCurrentLock = resolve;
    });

    this.slotLocks.set(
      slotId,
      previousLock.then(() => currentLock)
    );

    await previousLock;

    try {
      return await operation();
    } finally {
      releaseCurrentLock();
    }
  }

  private newBooking(input: {
    slot_id: string;
    explorer_id: string;
    headcount: number;
    amount_inr: number;
    status: BookingRecord['status'];
  }): BookingRecord {
    const timestamp = '2026-06-17T07:00:00.000Z';

    return {
      id: randomUUID(),
      slot_id: input.slot_id,
      explorer_id: input.explorer_id,
      headcount: input.headcount,
      amount_inr: input.amount_inr,
      status: input.status,
      payment_id: null,
      created_at: timestamp,
      updated_at: timestamp
    };
  }
}

describe('Bookings module', () => {
  let app: NestFastifyApplication;
  let bookingsRepository: FakeBookingsRepository;

  const hostProfileId = randomUUID();
  const explorerProfileId = randomUUID();
  const secondExplorerProfileId = randomUUID();
  const strangerProfileId = randomUUID();
  const hostToken = 'host-token';
  const explorerToken = 'explorer-token';
  const secondExplorerToken = 'second-explorer-token';
  const strangerToken = 'stranger-token';

  beforeAll(async () => {
    bookingsRepository = new FakeBookingsRepository();

    const moduleRef = await Test.createTestingModule({
      imports: [BookingsModule]
    })
      .overrideProvider(AuthService)
      .useValue(
        new FakeAuthService(
          new Map([
            [hostToken, hostProfileId],
            [explorerToken, explorerProfileId],
            [secondExplorerToken, secondExplorerProfileId],
            [strangerToken, strangerProfileId]
          ])
        )
      )
      .overrideProvider(BOOKINGS_REPOSITORY)
      .useValue(bookingsRepository)
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
    bookingsRepository.reset();
  });

  afterAll(async () => {
    await app.close();
  });

  it('allows exactly one simultaneous booking against a capacity-1 slot', async () => {
    const activityId = bookingsRepository.addActivity({
      host_id: hostProfileId,
      base_price_inr: 1499
    });
    const slotId = bookingsRepository.addSlot(activityId, { capacity: 1 });
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        app.inject({
          method: 'POST',
          url: '/bookings',
          headers: {
            authorization: `Bearer ${explorerToken}`
          },
          payload: {
            slotId,
            headcount: 1,
            amountInr: 1
          }
        })
      )
    );

    const successfulResponses = responses.filter((response) => response.statusCode === 201);
    const rejectedResponses = responses.filter((response) => response.statusCode === 400);

    expect(successfulResponses).toHaveLength(1);
    expect(rejectedResponses).toHaveLength(11);

    const successfulResponse = successfulResponses[0];

    if (successfulResponse === undefined) {
      throw new Error('Expected one successful booking response');
    }

    const created = successfulResponse.json() as CreateBookingResponse;

    expect(created).toMatchObject({
      payment_required_next: true,
      booking: {
        slot_id: slotId,
        explorer_id: explorerProfileId,
        headcount: 1,
        amount_inr: 1499,
        status: 'pending'
      }
    });
    expect(bookingsRepository.getSlot(slotId)).toMatchObject({
      booked_count: 1,
      status: 'full'
    });
    expect(bookingsRepository.domainEventsFor(created.booking.id)).toEqual([
      expect.objectContaining({
        aggregate_type: 'booking',
        aggregate_id: created.booking.id,
        event_type: 'booking.created'
      })
    ]);
  });

  it('cancels a future booking and reopens capacity', async () => {
    const activityId = bookingsRepository.addActivity({
      host_id: hostProfileId,
      base_price_inr: 750
    });
    const slotId = bookingsRepository.addSlot(activityId, { capacity: 1 });
    const createResponse = await app.inject({
      method: 'POST',
      url: '/bookings',
      headers: {
        authorization: `Bearer ${explorerToken}`
      },
      payload: {
        slotId,
        headcount: 1
      }
    });
    const created = createResponse.json() as CreateBookingResponse;

    expect(createResponse.statusCode).toBe(201);
    expect(bookingsRepository.getSlot(slotId)).toMatchObject({
      booked_count: 1,
      status: 'full'
    });

    const cancelResponse = await app.inject({
      method: 'POST',
      url: `/bookings/${created.booking.id}/cancel`,
      headers: {
        authorization: `Bearer ${explorerToken}`
      }
    });
    const cancelled = cancelResponse.json() as CancelBookingResponse;

    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelled).toMatchObject({
      maidan_way_note: RESPONSIBLE_CANCELLATION_NOTE,
      booking: {
        id: created.booking.id,
        status: 'cancelled'
      }
    });
    expect(bookingsRepository.getSlot(slotId)).toMatchObject({
      booked_count: 0,
      status: 'open'
    });
    expect(bookingsRepository.domainEventsFor(created.booking.id)).toEqual([
      expect.objectContaining({ event_type: 'booking.created' }),
      expect.objectContaining({ event_type: 'booking.cancelled' })
    ]);

    const replacementResponse = await app.inject({
      method: 'POST',
      url: '/bookings',
      headers: {
        authorization: `Bearer ${secondExplorerToken}`
      },
      payload: {
        slotId,
        headcount: 1
      }
    });

    expect(replacementResponse.statusCode).toBe(201);
  });

  it('lists explorer bookings and restricts activity bookings to the host', async () => {
    const activityId = bookingsRepository.addActivity({
      host_id: hostProfileId,
      base_price_inr: 500
    });
    const slotId = bookingsRepository.addSlot(activityId, { capacity: 3 });
    const explorerCreateResponse = await app.inject({
      method: 'POST',
      url: '/bookings',
      headers: {
        authorization: `Bearer ${explorerToken}`
      },
      payload: {
        slotId,
        headcount: 1
      }
    });
    const secondExplorerCreateResponse = await app.inject({
      method: 'POST',
      url: '/bookings',
      headers: {
        authorization: `Bearer ${secondExplorerToken}`
      },
      payload: {
        slotId,
        headcount: 1
      }
    });

    expect(explorerCreateResponse.statusCode).toBe(201);
    expect(secondExplorerCreateResponse.statusCode).toBe(201);

    const myBookingsResponse = await app.inject({
      method: 'GET',
      url: '/bookings/me',
      headers: {
        authorization: `Bearer ${explorerToken}`
      }
    });
    const myBookings = myBookingsResponse.json() as BookingRecord[];

    expect(myBookingsResponse.statusCode).toBe(200);
    expect(myBookings).toHaveLength(1);
    expect(myBookings[0]).toMatchObject({
      explorer_id: explorerProfileId,
      slot_id: slotId
    });

    const hostBookingsResponse = await app.inject({
      method: 'GET',
      url: `/activities/${activityId}/bookings`,
      headers: {
        authorization: `Bearer ${hostToken}`
      }
    });
    const hostBookings = hostBookingsResponse.json() as BookingRecord[];

    expect(hostBookingsResponse.statusCode).toBe(200);
    expect(hostBookings).toHaveLength(2);

    const strangerBookingsResponse = await app.inject({
      method: 'GET',
      url: `/activities/${activityId}/bookings`,
      headers: {
        authorization: `Bearer ${strangerToken}`
      }
    });

    expect(strangerBookingsResponse.statusCode).toBe(404);
  });
});

function cloneBooking(booking: BookingRecord): BookingRecord {
  return { ...booking };
}

async function nextTick(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}
