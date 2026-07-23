import { Injectable, NotFoundException } from '@nestjs/common';
import { SessionType } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { DAILY_SESSION_TYPE, END_OF_DAY } from '../common/session/daily-session';

/**
 * Same-day session resolution.
 *
 * Booking is always "today" and a doctor sits ONE session per day, so this
 * resolves to that session if the doctor is scheduled today. The session runs
 * from `startTime` until end-of-day — there is nothing later to bound it.
 *
 * Previously a MORNING session was treated as ending when the doctor's EVENING
 * session began, which is how the old two-block model inferred an end time
 * without an `endTime` column. With one continuous session per day that
 * inference is gone: a doctor who has started is open for the rest of the day.
 * See `common/session/daily-session.ts` for why the enum still exists.
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

    // One session per day. Legacy data (or a schedule edited before the change)
    // could still hold more than one row for today, so take the earliest start
    // rather than assuming exactly one — the day is a single block either way.
    const startTime = today
      .map((s) => s.startTime)
      .sort((a, b) => a.localeCompare(b))[0];

    // A day's session ends with the day, so the only "ENDED" case is a clock
    // past midnight, which cannot happen for today. Kept as a guard, not a rule.
    if (hm(now) >= toMinutes(END_OF_DAY)) {
      return { status: 'NONE', reason: 'ENDED' };
    }

    return {
      status: 'OPEN',
      session: {
        sessionType: DAILY_SESSION_TYPE,
        sessionDate: ymdLocal(now),
        startTime,
        endTime: END_OF_DAY,
        fee: doctor.consultationFee,
      },
    };
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
