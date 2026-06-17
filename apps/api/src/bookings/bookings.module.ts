import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BOOKINGS_REPOSITORY } from './bookings.constants';
import { BookingsController } from './bookings.controller';
import { PostgresBookingsRepository } from './bookings.repository';
import { BookingsService } from './bookings.service';

@Module({
  imports: [AuthModule],
  controllers: [BookingsController],
  providers: [
    BookingsService,
    {
      provide: BOOKINGS_REPOSITORY,
      useClass: PostgresBookingsRepository
    }
  ]
})
export class BookingsModule {}
