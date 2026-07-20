import { Module } from '@nestjs/common';
import { ConsultationNotesService } from './consultation-notes.service';

/**
 * Consultation notes shared service. No controller of its own — the routes live
 * on the role-scoped surfaces that already exist: doctor writes/reads via
 * /doctor/*, the patient reads via /me/bookings/*. Both import this module.
 */
@Module({
  providers: [ConsultationNotesService],
  exports: [ConsultationNotesService],
})
export class ConsultationNotesModule {}
