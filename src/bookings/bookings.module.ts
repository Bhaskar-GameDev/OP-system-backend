import { Module } from '@nestjs/common';
import { BookingsService } from './bookings.service';
import { BookingsController } from './bookings.controller';
import { BookingActionsService } from './booking-actions.service';
import { BookingActionsController } from './booking-actions.controller';
import { ConsultationNotesModule } from '../consultation-notes/consultation-notes.module';
import { PaymentsModule } from '../payments/payments.module';
import { QueueEngineModule } from '../queue-engine/queue-engine.module';
import { NotificationsModule } from '../notifications/notifications.module';

// Patient App backend dep — a patient's own past + upcoming booking history,
// read access to a completed visit's consultation note, plus patient-initiated
// cancellation + rescheduling (reusing Payments + Queue Engine + Notifications).
@Module({
  imports: [
    ConsultationNotesModule,
    PaymentsModule, // refund / void primitive
    QueueEngineModule, // ConsultationService (lock-guarded queue ops) + AuditService
    NotificationsModule, // cancel / reschedule push
  ],
  controllers: [BookingsController, BookingActionsController],
  providers: [BookingsService, BookingActionsService],
})
export class BookingsModule {}
