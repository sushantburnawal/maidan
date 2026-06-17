import type { BookingStatus } from '@maidan/shared';

export interface BookingRecord {
  id: string;
  slot_id: string;
  explorer_id: string;
  headcount: number;
  amount_inr: number;
  status: BookingStatus;
  payment_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateBookingInput {
  slot_id: string;
  headcount: number;
}

export interface CreateBookingResponse {
  booking: BookingRecord;
  payment_required_next: boolean;
}

export interface CancelBookingResponse {
  booking: BookingRecord;
  maidan_way_note: string;
}

export interface BookingsRepository {
  createBooking(explorerId: string, input: CreateBookingInput): Promise<BookingRecord | undefined>;
  cancelBooking(bookingId: string, explorerId: string): Promise<BookingRecord | undefined>;
  findExplorerBookings(explorerId: string): Promise<BookingRecord[]>;
  findActivityBookings(activityId: string, hostId: string): Promise<BookingRecord[] | undefined>;
}
