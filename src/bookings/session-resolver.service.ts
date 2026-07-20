import { Injectable, NotFoundException } from '@nestjs/common';
import { SessionType } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';

/**
 * Same-day session auto-resolution.
 *
 * Booking is always "today" — the patient supplies a doctorId only, and we pick
 * which of that doctor's sessions scheduled today they join. The data model has
 * NO session end time (DoctorSession stores only `startTime`), so "has it ended"
 * is INFERRED:
 *   - a MORNING session ends when that doctor's EVENING session starts today
 *     (or at end-of-day if the doctor sits no evening today);
 *   - an EVENING session ends at end-of-day.
 * Among today's not-yet-ended sessions we assign the one starting soonest.
 *
 * Decided over adding a DoctorSession.endTime column so the admin session CRUD
 * (explicitly out of scope) stays untouched. If a real end time is added later,
 * `sessionEndMinutes` is the single place to swap the rule.
 */

export interface ResolvedSession {
  sessionType: SessionType;
  sessionDate: string; // YYYY-MM-DD (today, server-local)
  startTime: string; // "HH:MM"
  /** Inferred end ("HH:MM"); '24:00' means end-of-day. Informational. */
  endTime: string;
  fee: number; // doctor.consultationFee at resolution time
}

export type TodaySession =
  | { status: 'OPEN'; session: ResolvedSession }
  | { status: 'NONE'; reason: 'NOT_SCHEDULED' | 'ENDED' };

const END_OF_DAY = '24:00';

@Injectable()
export class SessionResolverService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve the session a patient would join right now for `doctorId`.
   * Pure of side effects — used both by the booking path (which throws on a
   * non-OPEN result) and the public "today" endpoint (which surfaces it as-is).
   * `now` is injectable so tests can pin the clock.
   */
  async resolveToday(doctorId: string, now: Date = new Date()): Promise<TodaySession> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: doctorId },
      select: {
        consultationFee: true,
        sessions: {
          select: { sessionType: true, startTime: true, daysOfWeek: true },
        },
      },
    });
    if (!doctor) throw new NotFoundException('doctor not found');

    const dow = now.getDay();
    const today = doctor.sessions.filter((s) => s.daysOfWeek.includes(dow));
    if (today.length === 0) return { status: 'NONE', reason: 'NOT_SCHEDULED' };

    // Earliest evening start today bounds when a morning session "ends".
    const eveningStart = today
      .filter((s) => s.sessionType === SessionType.EVENING)
      .map((s) => s.startTime)
      .sort()[0];

    const nowHm = hm(now);
    const open = today
      .map((s) => ({
        sessionType: s.sessionType,
        startTime: s.startTime,
        endTime: this.sessionEndMinutes(s.sessionType, eveningStart),
      }))
      .filter((s) => nowHm < toMinutes(s.endTime))
      .sort((a, b) => a.startTime.localeCompare(b.startTime));

    if (open.length === 0) return { status: 'NONE', reason: 'ENDED' };

    const chosen = open[0];
    return {
      status: 'OPEN',
      session: {
        sessionType: chosen.sessionType,
        sessionDate: ymdLocal(now),
        startTime: chosen.startTime,
        endTime: chosen.endTime,
        fee: doctor.consultationFee,
      },
    };
  }

  /** Inferred end "HH:MM" for a session type given today's earliest evening start. */
  private sessionEndMinutes(type: SessionType, eveningStart: string | undefined): string {
    if (type === SessionType.MORNING && eveningStart) return eveningStart;
    return END_OF_DAY;
  }
}

/** Minutes-since-midnight of an "HH:MM" string ('24:00' -> 1440). */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((n) => Number(n));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

/** Minutes-since-midnight of a Date in server-local time. */
function hm(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
