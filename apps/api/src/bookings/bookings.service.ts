import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { BOOKINGS_REPOSITORY, RESPONSIBLE_CANCELLATION_NOTE } from './bookings.constants';
import { PaymentsService } from '../payments/payments.service';
import type {
  BookingsRepository,
  BookingRecord,
  CancelBookingResponse,
  CreateBookingInput,
  CreateBookingResponse
} from './bookings.types';
import type { CreateBookingDto } from './dto/create-booking.dto';

@Injectable()
export class BookingsService {
  constructor(
    @Inject(BOOKINGS_REPOSITORY) private readonly repository: BookingsRepository,
    private readonly paymentsService: PaymentsService
  ) {}

  async createBooking(explorerId: string, dto: CreateBookingDto): Promise<CreateBookingResponse> {
    const booking = await this.repository.createBooking(explorerId, toCreateBookingInput(dto));

    if (booking === undefined) {
      throw new NotFoundException('Slot not found');
    }

    return {
      booking,
      payment_required_next: true
    };
  }

  async cancelBooking(bookingId: string, explorerId: string): Promise<CancelBookingResponse> {
    const booking = await this.repository.cancelBooking(bookingId, explorerId);

    if (booking === undefined) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.payment_id !== null) {
      await this.paymentsService.refundCancelledBookingIfPaid(booking.id);
    }

    return {
      booking,
      maidan_way_note: RESPONSIBLE_CANCELLATION_NOTE
    };
  }

  async findMyBookings(explorerId: string): Promise<BookingRecord[]> {
    return this.repository.findExplorerBookings(explorerId);
  }

  async findActivityBookings(activityId: string, hostId: string): Promise<BookingRecord[]> {
    const bookings = await this.repository.findActivityBookings(activityId, hostId);

    if (bookings === undefined) {
      throw new NotFoundException('Activity not found');
    }

    return bookings;
  }
}

function toCreateBookingInput(dto: CreateBookingDto): CreateBookingInput {
  return {
    slot_id: dto.slotId,
    headcount: dto.headcount
  };
}
