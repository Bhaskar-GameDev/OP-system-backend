import { Injectable, NotFoundException } from '@nestjs/common';
import { BookingStatus, SessionType } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { SessionResolverService } from '../bookings/session-resolver.service';
import { QueueService } from '../queue-engine/queue.service';
import { SessionKey } from '../queue-engine/token.service';

/**
 * How many recently-completed tokens each card carries. Enough for a patient who
 * stepped out to tell whether their number has already been called.
 */
export const RECENT_TOKEN_COUNT = 5;

/**
 * Below this many people waiting, an ETA is noise (one no-show or a short
 * consult swamps it), so the card reports `null` and the page hides the line.
 */
export const ETA_MIN_WAITING = 2;

/**
 * One doctor's card on the waiting-room board.
 *
 * PRIVACY BOUNDARY. This is the shape served to an UNAUTHENTICATED wall display.
 * It carries doctor-facing identity (already public — patients pick a doctor by
 * name before booking), token numbers, and counts. It must NEVER gain a patient
 * name, patient id, booking id, mobile number or payment field. The service
 * below never selects those columns, so the omission is structural rather than
 * something a caller has to remember to strip.
 */
export interface DisplayDoctorCard {
  doctorId: string;
  name: string;
  specialization: string | null;
  sessionType: SessionType;
  /** Token at the front of the queue — the patient being consulted now. */
  nowServing: string | null;
  /** Most-recently completed tokens, newest first. */
  recentTokens: string[];
  /** People queued behind the one being served. */
  waitingCount: number;
  /** Minutes a patient joining now would wait; null when too small to mean much. */
  nextEtaMinutes: number | null;
}

/** Full board for one clinic — what a single display URL renders. */
export interface DisplayBoard {
  clinicId: string;
  clinicName: string;
  /** Server-local date the board is for (YYYY-MM-DD). */
  date: string;
  doctors: DisplayDoctorCard[];
}

/**
 * Read-only projection of the live queue for the waiting-room TV.
 *
 * Deliberately a projection rather than a reuse of the staff queue payload: the
 * staff view resolves tokens back to bookings (and therefore patients), and the
 * public display must not be able to. Everything here is derived from the Redis
 * ordering plus non-patient columns.
 */
@Injectable()
export class DisplayService {
  /**
   * doctorId -> clinicId. Resolved on the queue-event hot path, and a doctor
   * never changes clinic in the life of a process, so caching it keeps a
   * per-mutation database round-trip out of the broadcast path.
   */
  private readonly clinicByDoctor = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly sessions: SessionResolverService,
  ) {}

  /** Resolve a clinic, or 404. Callers use this to reject unknown display URLs. */
  async assertClinic(clinicId: string): Promise<{ id: string; name: string }> {
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { id: true, name: true },
    });
    if (!clinic) throw new NotFoundException('clinic not found');
    return clinic;
  }

  /** The clinic a doctor belongs to — the gateway's session -> display room hop. */
  async clinicIdForDoctor(doctorId: string): Promise<string | null> {
    const cached = this.clinicByDoctor.get(doctorId);
    if (cached) return cached;

    const doctor = await this.prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { clinicId: true },
    });
    if (!doctor) return null;
    this.clinicByDoctor.set(doctorId, doctor.clinicId);
    return doctor.clinicId;
  }

  /**
   * Build the whole board for a clinic.
   *
   * A doctor appears when they are scheduled to consult right now, OR when they
   * still have people queued today even though their scheduled window has
   * lapsed — a queue that ran long is exactly when the waiting room most needs
   * the screen. Doctors with neither are omitted; doctors with one but an empty
   * queue stay on the board in an idle state (they still take walk-ins).
   */
  async board(clinicId: string, now: Date = new Date()): Promise<DisplayBoard> {
    const clinic = await this.assertClinic(clinicId);

    const doctors = await this.prisma.doctor.findMany({
      where: { clinicId },
      select: {
        id: true,
        name: true,
        specialization: true,
        avgConsultMinutes: true,
      },
      orderBy: { name: 'asc' },
    });

    const date = ymdLocal(now);
    const cards: DisplayDoctorCard[] = [];
    for (const doctor of doctors) {
      const sessionType = await this.activeSessionType(doctor.id, date, now);
      if (!sessionType) continue;
      cards.push(
        await this.card(
          { ...doctor, sessionType },
          { doctorId: doctor.id, sessionDate: date, sessionType },
        ),
      );
    }

    return {
      clinicId: clinic.id,
      clinicName: clinic.name,
      date,
      doctors: cards,
    };
  }

  /**
   * Which session of the doctor's day the board should show, or null if they
   * are not on the board at all. Prefers the scheduled-and-open session; falls
   * back to whichever of today's sessions still has a live queue.
   */
  private async activeSessionType(
    doctorId: string,
    date: string,
    now: Date,
  ): Promise<SessionType | null> {
    const today = await this.sessions.resolveToday(doctorId, now);
    if (today.status === 'OPEN') return today.session.sessionType;

    for (const sessionType of [SessionType.MORNING, SessionType.EVENING]) {
      const size = await this.queue.size({ doctorId, sessionDate: date, sessionType });
      if (size > 0) return sessionType;
    }
    return null;
  }

  /**
   * One card. Exposed so the gateway can rebuild just the doctor whose queue
   * changed instead of the whole board on every event.
   */
  async cardForSession(session: SessionKey): Promise<DisplayDoctorCard | null> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: session.doctorId },
      select: {
        id: true,
        name: true,
        specialization: true,
        avgConsultMinutes: true,
      },
    });
    if (!doctor) return null;
    return this.card(
      { ...doctor, sessionType: session.sessionType as SessionType },
      session,
    );
  }

  private async card(
    doctor: {
      id: string;
      name: string;
      specialization: string | null;
      avgConsultMinutes: number;
      sessionType: SessionType;
    },
    session: SessionKey,
  ): Promise<DisplayDoctorCard> {
    const [tokens, recentTokens] = await Promise.all([
      this.queue.list(session),
      this.recentTokens(session),
    ]);

    // Rank 0 is the patient being consulted; everyone behind them is waiting.
    const nowServing = tokens.length > 0 ? tokens[0] : null;
    const waitingCount = Math.max(0, tokens.length - 1);

    return {
      doctorId: doctor.id,
      name: doctor.name,
      specialization: doctor.specialization,
      sessionType: doctor.sessionType,
      nowServing,
      recentTokens,
      waitingCount,
      nextEtaMinutes:
        waitingCount >= ETA_MIN_WAITING
          ? waitingCount * doctor.avgConsultMinutes
          : null,
    };
  }

  /**
   * Recently completed token numbers, newest first.
   *
   * Ordered by consultation_ended_at, which only COMPLETED bookings carry —
   * no-shows deliberately leave it null and so never appear here. Selecting
   * `tokenNumber` alone is what keeps patient identity out of the public feed.
   */
  private async recentTokens(session: SessionKey): Promise<string[]> {
    const rows = await this.prisma.booking.findMany({
      where: {
        doctorId: session.doctorId,
        sessionDate: new Date(`${session.sessionDate}T00:00:00.000Z`),
        sessionType: session.sessionType as SessionType,
        status: BookingStatus.COMPLETED,
        tokenNumber: { not: null },
        consultationEndedAt: { not: null },
      },
      orderBy: { consultationEndedAt: 'desc' },
      take: RECENT_TOKEN_COUNT,
      select: { tokenNumber: true },
    });
    return rows.map((r) => r.tokenNumber).filter((t): t is string => t !== null);
  }
}

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
