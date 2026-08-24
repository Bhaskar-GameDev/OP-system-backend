import { INestApplication, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BookingSource, BookingStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PaymentsService } from '../src/payments/payments.service';
import { BookingLimitService } from '../src/bookings/booking-limit.service';
import { FakeRazorpayGateway, RAZORPAY_GATEWAY } from '../src/payments/razorpay.gateway';

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
 *
 * FIXTURES ARE OWNED BY THIS SPEC. It used to book against the SEEDED demo
 * doctors (resolved by username, plus every doctor in the table) and assume they
 * all had an open session today. That made a test of booking limits fail for a
 * reason that has nothing to do with booking limits: taking a demo doctor off
 * today's schedule — an ordinary clinic-configuration change — turned nine
 * assertions red with "this doctor has no sessions today". Its own clinic and
 * doctors, created and torn down here, are independent of how any real clinic is
 * configured.
 */
describe('Per-patient booking limits', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let payments: PaymentsService;
  let limits: BookingLimitService;

  const PATIENT = 'bl-pt-01';
  const OTHER_PATIENT = 'bl-pt-02';
  const HOSP = 'bl-hosp';
  const CLINIC = 'bl-clinic';
  /** Enough for the daily cap (3) plus headroom for the over-cap assertions. */
  const DOCTOR_IDS = ['bl-doc-1', 'bl-doc-2', 'bl-doc-3', 'bl-doc-4', 'bl-doc-5'];

  /** The one doctor the single-doctor rules (A, C, D) book against. */
  const PRIMARY = DOCTOR_IDS[0];

  /** This spec's own doctors, each with an open session today. */
  let openDoctors: string[] = [];

  beforeAll(async () => {
    // initiateBooking creates a Razorpay order. Without this override the spec
    // talks to the REAL Razorpay test API whenever RAZORPAY_KEY_ID is present in
    // the environment (it is, on a dev box) — and a run that creates a booking
    // per assertion gets 429'd, failing a booking-limits test on a payment
    // vendor's rate limit. Nothing here is testing the gateway.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RAZORPAY_GATEWAY)
      .useClass(FakeRazorpayGateway)
      .compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    payments = app.get(PaymentsService);
    limits = app.get(BookingLimitService);
    await app.init();

    await dropFixtures();
    await prisma.hospital.create({ data: { id: HOSP, name: 'BL Hospital' } });
    await prisma.clinic.create({
      data: { id: CLINIC, hospitalId: HOSP, name: 'BL Clinic' },
    });
    for (const [i, id] of DOCTOR_IDS.entries()) {
      await prisma.doctor.create({
        data: {
          id,
          clinicId: CLINIC,
          name: `BL Doctor ${i + 1}`,
          specialization: 'General Medicine',
          consultationFee: 100,
          // Every weekday, so "today" always resolves OPEN regardless of the
          // day the suite runs on.
          sessions: {
            create: {
              sessionType: 'MORNING',
              startTime: '09:00',
              maxTokens: 50,
              daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            },
          },
        },
      });
    }
    for (const id of [PATIENT, OTHER_PATIENT]) {
      await prisma.patient.create({
        data: { id, name: `BL Patient ${id}`, mobile: `9${id.replace(/\D/g, '')}000000`.slice(0, 10) },
      });
    }
    openDoctors = [...DOCTOR_IDS];
  });

  afterAll(async () => {
    await cleanup();
    await dropFixtures();
    await app.close();
  });

  /** Remove everything this spec creates, in FK-safe order. */
  async function dropFixtures(): Promise<void> {
    await prisma.payment.deleteMany({
      where: { booking: { doctorId: { in: DOCTOR_IDS } } },
    });
    await prisma.booking.deleteMany({ where: { doctorId: { in: DOCTOR_IDS } } });
    await prisma.doctorSession.deleteMany({ where: { doctorId: { in: DOCTOR_IDS } } });
    await prisma.doctor.deleteMany({ where: { id: { in: DOCTOR_IDS } } });
    await prisma.patient.deleteMany({ where: { id: { in: [PATIENT, OTHER_PATIENT] } } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC } });
    await prisma.hospital.deleteMany({ where: { id: HOSP } });
  }

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
    const res = await initiate(PRIMARY);
    expect(res.bookingId).toBeDefined();
  });

  it('RULE A: refuses a second booking with the same doctor in the same session', async () => {
    await initiate(PRIMARY);
    await expect(initiate(PRIMARY)).rejects.toBeInstanceOf(ConflictException);
  });

  it('counts a PENDING_PAYMENT booking — the unpaid row is the attack surface', async () => {
    const first = await initiate(PRIMARY);
    const row = await prisma.booking.findUnique({ where: { id: first.bookingId } });
    expect(row?.status).toBe(BookingStatus.PENDING_PAYMENT);

    await expect(initiate(PRIMARY)).rejects.toThrow(/already have a booking/i);
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
    const first = await initiate(PRIMARY);
    await expect(initiate(PRIMARY)).rejects.toBeInstanceOf(ConflictException);

    await prisma.booking.update({
      where: { id: first.bookingId },
      data: { status: BookingStatus.CANCELLED },
    });

    // Same doctor, same session — now allowed again.
    const second = await initiate(PRIMARY);
    expect(second.bookingId).toBeDefined();
    expect(second.bookingId).not.toBe(first.bookingId);
  });

  it('RULE C: a COMPLETED consultation does not consume the limit', async () => {
    const first = await initiate(PRIMARY);
    await prisma.booking.update({
      where: { id: first.bookingId },
      data: { status: BookingStatus.COMPLETED },
    });

    await expect(initiate(PRIMARY)).resolves.toBeDefined();
  });

  it('RULE C: an EXPIRED (abandoned payment) booking does not strand the patient', async () => {
    const first = await initiate(PRIMARY);
    await prisma.booking.update({
      where: { id: first.bookingId },
      data: { status: BookingStatus.EXPIRED },
    });

    await expect(initiate(PRIMARY)).resolves.toBeDefined();
  });

  it('RULE D: concurrent requests for the same doctor-session cannot both succeed', async () => {
    const results = await Promise.allSettled([
      initiate(PRIMARY),
      initiate(PRIMARY),
      initiate(PRIMARY),
      initiate(PRIMARY),
      initiate(PRIMARY),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);

    // And the database agrees — exactly one live row, no torn writes.
    const live = await prisma.booking.count({
      where: {
        patientId: PATIENT,
        doctorId: PRIMARY,
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
    await initiate(PRIMARY, PATIENT);
    await expect(initiate(PRIMARY, PATIENT)).rejects.toBeInstanceOf(ConflictException);

    // A different patient booking the same doctor is unaffected.
    await expect(initiate(PRIMARY, OTHER_PATIENT)).resolves.toBeDefined();
  });

  it('the limit is server-side — it applies to a direct service call, not just HTTP', async () => {
    // This test IS the direct call; a client bypassing the app entirely still
    // hits the same guard because it lives below the controller.
    await initiate(PRIMARY);
    await expect(initiate(PRIMARY)).rejects.toBeInstanceOf(ConflictException);
  });
});
