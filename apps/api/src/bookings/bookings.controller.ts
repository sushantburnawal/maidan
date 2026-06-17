import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards
} from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BookingsService } from './bookings.service';
import type { BookingRecord, CancelBookingResponse, CreateBookingResponse } from './bookings.types';
import { CreateBookingDto } from './dto/create-booking.dto';

@Controller()
@UseGuards(JwtAuthGuard)
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @Post('bookings')
  async createBooking(
    @CurrentUser('profileId') profileId: string,
    @Body() dto: CreateBookingDto
  ): Promise<CreateBookingResponse> {
    return this.bookingsService.createBooking(profileId, dto);
  }

  @Post('bookings/:id/cancel')
  @HttpCode(200)
  async cancelBooking(
    @CurrentUser('profileId') profileId: string,
    @Param('id', ParseUUIDPipe) bookingId: string
  ): Promise<CancelBookingResponse> {
    return this.bookingsService.cancelBooking(bookingId, profileId);
  }

  @Get('bookings/me')
  async findMyBookings(@CurrentUser('profileId') profileId: string): Promise<BookingRecord[]> {
    return this.bookingsService.findMyBookings(profileId);
  }

  @Get('activities/:id/bookings')
  async findActivityBookings(
    @CurrentUser('profileId') profileId: string,
    @Param('id', ParseUUIDPipe) activityId: string
  ): Promise<BookingRecord[]> {
    return this.bookingsService.findActivityBookings(activityId, profileId);
  }
}
