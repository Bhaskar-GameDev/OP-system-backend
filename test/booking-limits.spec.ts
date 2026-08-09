import { INestApplication, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BookingSource, BookingStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PaymentsService } from '../src/payments/payments.service';
import { BookingLimitService } from '../src/bookings/booking-limit.service';

/**
 * P0-8 — per-patient booking abuse protection.
 *
 * Before this, `initiateBooking` created a booking row before any payment with
 * no cap at all, so one authenticated account could hold unlimited places
 * across every doctor and lock a clinic out of its own queue.
 *
 * Rules under test:
 *   A. one live booking per patient per doctor-session
 *   B. a daily cap across doctors (default 3)
 *   C. cancelled / expired / completed bookings release capacity
 *   D. concurrent requests cannot bypass either rule
 *
 * Runs against real Postgres because the concurrency guarantee is a database
 * advisory lock — an in-memory double would prove nothing about it.
 */
describe('Per-patient booking limits', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let payments: PaymentsService;
  let limits: BookingLimitService;

  const PATIENT = 'demo-pt-01';
  const OTHER_PATIENT = 'demo-pt-02';

  // Resolved by username, not a hardcoded id: seeded privileged accounts no
  // longer have predictable UUIDs (P0.6).
  let DR_SMITH: string;

  /** Doctors seeded with an open session today, used for the daily-cap tests. */
  let openDoctors: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    payments = app.get(PaymentsService);
    limits = app.get(BookingLimitService);
    await app.init();

    DR_SMITH = (
      await prisma.doctor.findUniqueOrThrow({
        where: { username: 'drsmith' },
        select: { id: true },
      })
    ).id;

    const doctors = await prisma.doctor.findMany({ select: { id: true } });
    openDoctors = doctors.map((d) => d.id);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await prisma.payment.deleteMany({
      where: { booking: { patientId: { in: [PATIENT, OTHER_PATIENT] } } },
    });
    await prisma.booking.deleteMany({
      where: { patientId: { in: [PATIENT, OTHER_PATIENT] }, source: BookingSource.APP },
    });
  }

  beforeEach(cleanup);

  const initiate = (doctorId: string, patientId = PATIENT) =>
    payments.initiateBooking({ patientId, doctorId, source: BookingSource.APP });

  it('allows a first valid booking', async () => {
    const res = await initiate(DR_SMITH);
    expect(res.bookingId).toBeDefined();
  });

  it('RULE A: refuses a second booking with the same doctor in the same session', async () => {
    await initiate(DR_SMITH);
    await expect(initiate(DR_SMITH)).rejects.toBeInstanceOf(ConflictException);
  });

  it('counts a PENDING_PAYMENT booking — the unpaid row is the attack surface', async () => {
    const first = await initiate(DR_SMITH);
    const row = await prisma.booking.findUnique({ where: { id: first.bookingId } });
    expect(row?.status).toBe(BookingStatus.PENDING_PAYMENT);

    await expect(initiate(DR_SMITH)).rejects.toThrow(/already have a booking/i);
  });

  it('RULE B: enforces the daily cap across DIFFERENT doctors', async () => {
    const cap = limits.maxLivePerDay;
    const usable = openDoctors.slice(0, cap + 2);
    if (usable.length < cap + 1) {
      throw new Error('seed does not provide enough doctors to exercise the daily cap');
    }

    let created = 0;
    let rejected = 0;
    for (const doctorId of usable) {
      try {
        await initiate(doctorId);
        created += 1;
      } catch {
        rejected += 1;
      }
    }

    expect(created).toBeLessThanOrEqual(cap);
    expect(rejected).toBeGreaterThan(0);
  });

  it('RULE C: cancelling releases capacity', async () => {
    const first = await initiate(DR_SMITH);
    await expect(initiate(DR_SMITH)).rejects.toBeInstanceOf(ConflictException);

    await prisma.booking.update({
      where: { id: first.bookingId },
      data: { status: BookingStatus.CANCELLED },
    });

    // Same doctor, same session — now allowed again.
    const second = await initiate(DR_SMITH);
    expect(second.bookingId).toBeDefined();
    expect(second.bookingId).not.toBe(first.bookingId);
  });

  it('RULE C: a COMPLETED consultation does not consume the limit', async () => {
    const first = await initiate(DR_SMITH);
    await prisma.booking.update({
      where: { id: first.bookingId },
      data: { status: BookingStatus.COMPLETED },
    });

    await expect(initiate(DR_SMITH)).resolves.toBeDefined();
  });

  it('RULE C: an EXPIRED (abandoned payment) booking does not strand the patient', async () => {
    const first = await initiate(DR_SMITH);
    await prisma.booking.update({
      where: { id: first.bookingId },
      data: { status: BookingStatus.EXPIRED },
    });

    await expect(initiate(DR_SMITH)).resolves.toBeDefined();
  });

  it('RULE D: concurrent requests for the same doctor-session cannot both succeed', async () => {
    const results = await Promise.allSettled([
      initiate(DR_SMITH),
      initiate(DR_SMITH),
      initiate(DR_SMITH),
      initiate(DR_SMITH),
      initiate(DR_SMITH),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);

    // And the database agrees — exactly one live row, no torn writes.
    const live = await prisma.booking.count({
      where: {
        patientId: PATIENT,
        doctorId: DR_SMITH,
        status: { in: BookingLimitService.LIVE_STATUSES },
      },
    });
    expect(live).toBe(1);
  });

  it('RULE D: concurrent requests across doctors cannot exceed the daily cap', async () => {
    const cap = limits.maxLivePerDay;
    const usable = openDoctors.slice(0, cap + 3);

    await Promise.allSettled(usable.map((d) => initiate(d)));

    const live = await prisma.booking.count({
      where: {
        patientId: PATIENT,
        status: { in: BookingLimitService.LIVE_STATUSES },
      },
    });
    expect(live).toBeLessThanOrEqual(cap);
  });

  it('limits are per patient — one patient cannot block another', async () => {
    await initiate(DR_SMITH, PATIENT);
    await expect(initiate(DR_SMITH, PATIENT)).rejects.toBeInstanceOf(ConflictException);

    // A different patient booking the same doctor is unaffected.
    await expect(initiate(DR_SMITH, OTHER_PATIENT)).resolves.toBeDefined();
  });

  it('the limit is server-side — it applies to a direct service call, not just HTTP', async () => {
    // This test IS the direct call; a client bypassing the app entirely still
    // hits the same guard because it lives below the controller.
    await initiate(DR_SMITH);
    await expect(initiate(DR_SMITH)).rejects.toBeInstanceOf(ConflictException);
  });
});
