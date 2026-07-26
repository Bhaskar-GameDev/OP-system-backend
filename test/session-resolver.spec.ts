import { NotFoundException } from '@nestjs/common';
import { SessionType } from '@prisma/client';
import { SessionResolverService } from '../src/bookings/session-resolver.service';
import { DAILY_SESSION_TYPE } from '../src/common/session/daily-session';

/**
 * Pure unit coverage of same-day session auto-resolution — no Redis/Postgres.
 * Prisma is faked so we control the doctor's sessions and pin the clock via the
 * injectable `now`, making the time-of-day branches deterministic.
 */

type FakeSession = { sessionType: SessionType; startTime: string; daysOfWeek: number[] };

function makeResolver(doctor: { consultationFee: number; sessions: FakeSession[] } | null) {
  const prisma = {
    doctor: {
      findUnique: jest.fn().mockResolvedValue(doctor),
    },
  };
  return new SessionResolverService(prisma as never);
}

// A fixed weekday with a known getDay(); 2026-06-24 is a Wednesday (dow 3).
const WED = (hh: number, mm = 0) => new Date(2026, 5, 24, hh, mm, 0, 0);
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

describe('SessionResolverService.resolveToday', () => {
  it('throws NotFound when the doctor does not exist', async () => {
    const r = makeResolver(null);
    await expect(r.resolveToday('nope', WED(8))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns NOT_SCHEDULED when the doctor sits no session today', async () => {
    const r = makeResolver({
      consultationFee: 300,
      // only Mondays (dow 1); our clock is a Wednesday
      sessions: [{ sessionType: DAILY_SESSION_TYPE, startTime: '09:00', daysOfWeek: [1] }],
    });
    const res = await r.resolveToday('d1', WED(10));
    expect(res).toEqual({ status: 'NONE', reason: 'NOT_SCHEDULED' });
  });

  it('assigns the only session left today (fee + window carried through)', async () => {
    const r = makeResolver({
      consultationFee: 450,
      sessions: [{ sessionType: DAILY_SESSION_TYPE, startTime: '09:00', daysOfWeek: ALL_DAYS }],
    });
    const res = await r.resolveToday('d1', WED(8));
    expect(res.status).toBe('OPEN');
    if (res.status !== 'OPEN') return;
    expect(res.session.sessionType).toBe(DAILY_SESSION_TYPE);
    expect(res.session.startTime).toBe('09:00');
    expect(res.session.endTime).toBe('24:00'); // a day's session ends with the day
    expect(res.session.fee).toBe(450);
    expect(res.session.sessionDate).toBe('2026-06-24');
  });

  it('a doctor scheduled today is open all day, even late in the evening', async () => {
    // The old model ended a MORNING session when that doctor's EVENING session
    // began. With one continuous session per day there is nothing to hand over
    // to: a doctor who consults today stays open until end-of-day.
    const r = makeResolver({
      consultationFee: 500,
      sessions: [{ sessionType: DAILY_SESSION_TYPE, startTime: '09:00', daysOfWeek: ALL_DAYS }],
    });
    const res = await r.resolveToday('d1', WED(18)); // long after the start time
    expect(res.status).toBe('OPEN');
    if (res.status !== 'OPEN') return;
    expect(res.session.startTime).toBe('09:00');
    expect(res.session.endTime).toBe('24:00');
  });

  it('collapses stray same-day rows to the earliest start (legacy data)', async () => {
    // A schedule edited before the one-session-per-day rule could still hold two
    // rows for today. The day is a single block either way, so the earliest
    // start wins rather than the resolver picking arbitrarily.
    const r = makeResolver({
      consultationFee: 500,
      sessions: [
        { sessionType: SessionType.EVENING, startTime: '17:00', daysOfWeek: ALL_DAYS },
        { sessionType: SessionType.MORNING, startTime: '09:00', daysOfWeek: ALL_DAYS },
      ],
    });
    const res = await r.resolveToday('d1', WED(7));
    expect(res.status).toBe('OPEN');
    if (res.status !== 'OPEN') return;
    expect(res.session.startTime).toBe('09:00');
    expect(res.session.endTime).toBe('24:00');
    expect(res.session.sessionType).toBe(DAILY_SESSION_TYPE); // always pinned
  });

  it('a doctor whose session starts later today is still joinable now', async () => {
    // Joining before the doctor starts is legitimate — the token holds a place
    // in the day's queue; it is not a time-slot reservation.
    const r = makeResolver({
      consultationFee: 400,
      sessions: [{ sessionType: DAILY_SESSION_TYPE, startTime: '17:00', daysOfWeek: ALL_DAYS }],
    });
    const res = await r.resolveToday('d1', WED(10)); // 10:00, doctor starts at 17:00
    expect(res.status).toBe('OPEN');
    if (res.status !== 'OPEN') return;
    expect(res.session.startTime).toBe('17:00');
    expect(res.session.endTime).toBe('24:00');
    expect(res.session.fee).toBe(400);
  });

  it('mid-day is still the same session — there is no hand-over point', async () => {
    const r = makeResolver({
      consultationFee: 500,
      sessions: [{ sessionType: DAILY_SESSION_TYPE, startTime: '09:00', daysOfWeek: ALL_DAYS }],
    });
    for (const hour of [9, 12, 16, 20, 23]) {
      const res = await r.resolveToday('d1', WED(hour));
      expect(res.status).toBe('OPEN');
      if (res.status !== 'OPEN') return;
      expect(res.session.startTime).toBe('09:00');
      expect(res.session.sessionType).toBe(DAILY_SESSION_TYPE);
    }
  });
});
