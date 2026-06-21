import { Module } from '@nestjs/common';
import { BookingsService } from './bookings.service';
import { BookingsController } from './bookings.controller';

// Patient App backend dep — a patient's own past + upcoming booking history.
@Module({
  controllers: [BookingsController],
  providers: [BookingsService],
})
export class BookingsModule {}
