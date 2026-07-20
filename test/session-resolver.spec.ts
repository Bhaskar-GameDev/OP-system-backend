import { NotFoundException } from '@nestjs/common';
import { SessionType } from '@prisma/client';
import { SessionResolverService } from '../src/bookings/session-resolver.service';

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
      sessions: [{ sessionType: SessionType.MORNING, startTime: '09:00', daysOfWeek: [1] }],
    });
    const res = await r.resolveToday('d1', WED(10));
    expect(res).toEqual({ status: 'NONE', reason: 'NOT_SCHEDULED' });
  });

  it('assigns the only session left today (fee + window carried through)', async () => {
    const r = makeResolver({
      consultationFee: 450,
      sessions: [{ sessionType: SessionType.MORNING, startTime: '09:00', daysOfWeek: ALL_DAYS }],
    });
    const res = await r.resolveToday('d1', WED(8));
    expect(res.status).toBe('OPEN');
    if (res.status !== 'OPEN') return;
    expect(res.session.sessionType).toBe(SessionType.MORNING);
    expect(res.session.startTime).toBe('09:00');
    expect(res.session.endTime).toBe('24:00'); // no evening -> ends end-of-day
    expect(res.session.fee).toBe(450);
    expect(res.session.sessionDate).toBe('2026-06-24');
  });

  it('with morning + evening before both, assigns the soonest-starting (morning)', async () => {
    const r = makeResolver({
      consultationFee: 500,
      sessions: [
        { sessionType: SessionType.EVENING, startTime: '17:00', daysOfWeek: ALL_DAYS },
        { sessionType: SessionType.MORNING, startTime: '09:00', daysOfWeek: ALL_DAYS },
      ],
    });
    const res = await r.resolveToday('d1', WED(7)); // before morning start
    expect(res.status).toBe('OPEN');
    if (res.status !== 'OPEN') return;
    expect(res.session.sessionType).toBe(SessionType.MORNING);
    expect(res.session.endTime).toBe('17:00'); // morning ends when evening starts
  });

  it('once the evening has started, the morning has ended -> assigns evening', async () => {
    const r = makeResolver({
      consultationFee: 500,
      sessions: [
        { sessionType: SessionType.MORNING, startTime: '09:00', daysOfWeek: ALL_DAYS },
        { sessionType: SessionType.EVENING, startTime: '17:00', daysOfWeek: ALL_DAYS },
      ],
    });
    const res = await r.resolveToday('d1', WED(18)); // 18:00, evening already running
    expect(res.status).toBe('OPEN');
    if (res.status !== 'OPEN') return;
    expect(res.session.sessionType).toBe(SessionType.EVENING);
    expect(res.session.endTime).toBe('24:00');
  });

  it('evening-only doctor (no morning) resolves the evening, even before it starts', async () => {
    const r = makeResolver({
      consultationFee: 400,
      sessions: [{ sessionType: SessionType.EVENING, startTime: '17:00', daysOfWeek: ALL_DAYS }],
    });
    const res = await r.resolveToday('d1', WED(10)); // 10:00, evening not started yet
    expect(res.status).toBe('OPEN');
    if (res.status !== 'OPEN') return;
    expect(res.session.sessionType).toBe(SessionType.EVENING);
    expect(res.session.startTime).toBe('17:00');
    expect(res.session.endTime).toBe('24:00'); // evening ends end-of-day
    expect(res.session.fee).toBe(400);
  });

  it('mid-day (after morning start, before evening) still assigns the morning until evening starts', async () => {
    const r = makeResolver({
      consultationFee: 500,
      sessions: [
        { sessionType: SessionType.MORNING, startTime: '09:00', daysOfWeek: ALL_DAYS },
        { sessionType: SessionType.EVENING, startTime: '17:00', daysOfWeek: ALL_DAYS },
      ],
    });
    const res = await r.resolveToday('d1', WED(12)); // noon: morning not ended yet
    expect(res.status).toBe('OPEN');
    if (res.status !== 'OPEN') return;
    expect(res.session.sessionType).toBe(SessionType.MORNING);
  });
});
