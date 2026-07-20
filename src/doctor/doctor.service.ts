import { Injectable, NotFoundException } from '@nestjs/common';
import { BookingStatus, SessionType } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { EtaService } from '../queue-engine/eta.service';
import { QueueService } from '../queue-engine/queue.service';
import { SessionKey } from '../queue-engine/token.service';
import {
  DoctorCompletedView,
  DoctorProfileView,
  DoctorQueueView,
  toDoctorQueueEntry,
} from './doctor.dto';

/**
 * Doctor-facing read surface. The doctor only ever sees their OWN session
 * (doctorId comes from the JWT, never a request param), for TODAY. Queue
 * ordering + ETA are reused verbatim from the Queue Engine (EtaService /
 * QueueService) — this service only joins the booking facts (name, source,
 * status) the dashboard needs. It performs NO queue mutations; the dashboard
 * drives done/skip/no-show through the existing audited /queue/* endpoints.
 */
@Injectable()
export class DoctorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly eta: EtaService,
  ) {}

  /** Server-local calendar date (YYYY-MM-DD) — matches how sessions are keyed. */
  private today(): string {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  async getProfile(doctorId: string): Promise<DoctorProfileView> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: doctorId },
      select: {
        id: true,
        name: true,
        specialization: true,
        clinicId: true,
        avgConsultMinutes: true,
      },
    });
    if (!doctor) throw new NotFoundException('doctor not found');
    return doctor;
  }

  /**
   * The doctor's live queue for today's session of the given type, front -> back.
   * Reuses EtaService.etaForQueue for the ordered list + ETA, then batch-joins
   * patient name / source / status by resolving each token to its booking.
   */
  async getQueue(
    doctorId: string,
    sessionType: SessionType,
  ): Promise<DoctorQueueView> {
    const sessionDate = this.today();
    const session: SessionKey = { doctorId, sessionDate, sessionType };

    const ordered = await this.eta.etaForQueue(session);

    // token -> bookingId (Redis map); skip raw/unmapped tokens
    const tokenToBooking = new Map<string, string>();
    for (const e of ordered) {
      const bookingId = await this.queue.bookingIdFor(e.tokenNumber, session);
      if (bookingId) tokenToBooking.set(e.tokenNumber, bookingId);
    }

    // one batched DB read for the booking facts
    const bookingIds = [...new Set(tokenToBooking.values())];
    const rows = bookingIds.length
      ? await this.prisma.booking.findMany({
          where: { id: { in: bookingIds } },
          select: {
            id: true,
            source: true,
            status: true,
            patient: { select: { name: true } },
          },
        })
      : [];
    const byId = new Map(rows.map((r) => [r.id, r]));

    const entries = ordered.map((e) => {
      const bookingId = tokenToBooking.get(e.tokenNumber) ?? null;
      const booking = bookingId ? byId.get(bookingId) ?? null : null;
      return toDoctorQueueEntry(e, bookingId, booking);
    });

    return {
      doctorId,
      sessionDate,
      sessionType,
      activeToken: entries.length > 0 ? entries[0].tokenNumber : null,
      total: entries.length,
      entries,
    };
  }

  /**
   * Today's COMPLETED consultations for the doctor's session — these have left
   * the live queue (DONE removes them), so they're surfaced here for note
   * view/edit. `hasNote` is resolved in one batched read. Scoped to TODAY so a
   * doctor only edits notes within the same session/day, per the spec.
   */
  async getCompleted(
    doctorId: string,
    sessionType: SessionType,
  ): Promise<DoctorCompletedView> {
    const sessionDate = this.today();

    // The live `bookings` table only holds the current day's settled rows: the
    // nightly archival sweep moves older terminal bookings into booking_history.
    // So all COMPLETED rows here are this session/day's — no date filter needed
    // (and none that would be fragile across the @db.Date / local-day boundary).
    const rows = await this.prisma.booking.findMany({
      where: { doctorId, sessionType, status: BookingStatus.COMPLETED },
      select: {
        id: true,
        tokenNumber: true,
        consultationEndedAt: true,
        patient: { select: { name: true } },
      },
      orderBy: { consultationEndedAt: 'asc' },
    });

    const noted = rows.length
      ? await this.prisma.consultationNote.findMany({
          where: { bookingId: { in: rows.map((r) => r.id) } },
          select: { bookingId: true },
        })
      : [];
    const hasNote = new Set(noted.map((n) => n.bookingId));

    return {
      doctorId,
      sessionDate,
      sessionType,
      entries: rows.map((r) => ({
        bookingId: r.id,
        tokenNumber: r.tokenNumber,
        patientName: r.patient?.name ?? null,
        consultationEndedAt: r.consultationEndedAt
          ? r.consultationEndedAt.toISOString()
          : null,
        hasNote: hasNote.has(r.id),
      })),
    };
  }
}
