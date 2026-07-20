import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  ConsultationNoteView,
  SaveConsultationNoteInput,
  toConsultationNoteView,
} from './consultation-note.dto';

/**
 * Consultation notes — the record that closes the doctor↔patient loop.
 *
 * Scope is enforced per call: a DOCTOR may only write/read notes for bookings
 * that are theirs; a PATIENT may only read the note for a booking they own.
 * Ownership is checked against the live `bookings` table OR the archived
 * `booking_history` (the archival sweep moves settled bookings between them),
 * so access works the same before and after a booking is archived.
 */
@Injectable()
export class ConsultationNotesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Upsert (create-or-edit) the note for one of the doctor's own bookings. */
  async saveForDoctor(
    doctorId: string,
    input: SaveConsultationNoteInput,
  ): Promise<ConsultationNoteView> {
    if (!input.bookingId) throw new BadRequestException('bookingId is required');
    await this.assertDoctorOwnsBooking(doctorId, input.bookingId);

    const followUpDate = parseFollowUp(input.followUpDate);
    const data = {
      notes: input.notes ?? '',
      diagnosis: emptyToNull(input.diagnosis),
      prescriptions: emptyToNull(input.prescriptions),
      followUpDate,
    };

    const note = await this.prisma.consultationNote.upsert({
      where: { bookingId: input.bookingId },
      create: { bookingId: input.bookingId, doctorId, ...data },
      update: data,
    });
    return toConsultationNoteView(note);
  }

  /** The doctor's own note for a booking, or null if none recorded yet. */
  async getForDoctor(
    doctorId: string,
    bookingId: string,
  ): Promise<ConsultationNoteView | null> {
    await this.assertDoctorOwnsBooking(doctorId, bookingId);
    const note = await this.prisma.consultationNote.findUnique({
      where: { bookingId },
    });
    return note ? toConsultationNoteView(note) : null;
  }

  /** The note for a booking the patient owns, or null if none recorded. */
  async getForPatient(
    patientId: string,
    bookingId: string,
  ): Promise<ConsultationNoteView | null> {
    const owns = await this.patientOwnsBooking(patientId, bookingId);
    if (!owns) throw new NotFoundException('booking not found');
    const note = await this.prisma.consultationNote.findUnique({
      where: { bookingId },
    });
    return note ? toConsultationNoteView(note) : null;
  }

  // ─── Scope helpers (live bookings + archived history) ───

  private async assertDoctorOwnsBooking(
    doctorId: string,
    bookingId: string,
  ): Promise<void> {
    const live = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { doctorId: true },
    });
    if (live) {
      if (live.doctorId !== doctorId) {
        throw new ForbiddenException('booking belongs to another doctor');
      }
      return;
    }
    const archived = await this.prisma.bookingHistory.findUnique({
      where: { bookingId },
      select: { doctorId: true },
    });
    if (!archived) throw new NotFoundException('booking not found');
    if (archived.doctorId !== doctorId) {
      throw new ForbiddenException('booking belongs to another doctor');
    }
  }

  private async patientOwnsBooking(
    patientId: string,
    bookingId: string,
  ): Promise<boolean> {
    const live = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { patientId: true },
    });
    if (live) return live.patientId === patientId;
    const archived = await this.prisma.bookingHistory.findUnique({
      where: { bookingId },
      select: { patientId: true },
    });
    return archived?.patientId === patientId;
  }
}

/** "" / undefined / null -> null; otherwise the trimmed value. */
function emptyToNull(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/** Validate an optional YYYY-MM-DD follow-up date -> UTC-midnight Date | null. */
function parseFollowUp(s: string | null | undefined): Date | null {
  if (s === undefined || s === null || s === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new BadRequestException('followUpDate must be YYYY-MM-DD');
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}
