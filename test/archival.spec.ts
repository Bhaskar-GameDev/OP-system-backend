import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BookingSource, BookingStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ArchivalService } from '../src/archival/archival.service';

describe('ArchivalService — decoupled sweep, atomic per-booking move (real Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let archival: ArchivalService;

  const CLINIC_ID = 'arch-clinic';
  const DOCTOR_ID = 'arch-doctor';
  const PATIENT_ID = 'arch-patient';

  // a fixed "now" so the test controls the before-today boundary deterministically
  const NOW = new Date('2026-06-19T10:00:00');
  const YESTERDAY = new Date('2026-06-18T09:00:00');
  let seq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    prisma = app.get(PrismaService);
    archival = app.get(ArchivalService);

    await prisma.clinic.upsert({
      where: { id: CLINIC_ID },
      create: { id: CLINIC_ID, name: 'Arch Clinic' },
      update: {},
    });
    await prisma.doctor.upsert({
      where: { id: DOCTOR_ID },
      create: { id: DOCTOR_ID, clinicId: CLINIC_ID, name: 'Dr Arch' },
      update: {},
    });
    await prisma.patient.upsert({
      where: { id: PATIENT_ID },
      create: { id: PATIENT_ID, name: 'Arch Pt', mobile: `9${Date.now()}` },
      update: {},
    });
  });

  beforeEach(async () => {
    await clean();
  });

  afterAll(async () => {
    await clean();
    await prisma.patient.deleteMany({ where: { id: PATIENT_ID } });
    await prisma.doctor.deleteMany({ where: { id: DOCTOR_ID } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC_ID } });
    await app.close();
  });

  async function clean(): Promise<void> {
    await prisma.bookingHistory.deleteMany({ where: { doctorId: DOCTOR_ID } });
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR_ID } });
  }

  async function makeBooking(
    status: BookingStatus,
    createdAt: Date,
  ): Promise<string> {
    const id = `arch-bk-${seq++}`;
    await prisma.booking.create({
      data: {
        id,
        patientId: PATIENT_ID,
        doctorId: DOCTOR_ID,
        source: BookingSource.APP,
        tokenNumber: `A${String(seq).padStart(3, '0')}`,
        sessionDate: createdAt,
        sessionType: 'MORNING',
        status,
        createdAt,
        consultationEndedAt: status === BookingStatus.COMPLETED ? createdAt : null,
      },
    });
    return id;
  }

  it('moves only prior-day TERMINAL bookings; same-day and non-terminal stay put', async () => {
    const priorCompleted = await makeBooking(BookingStatus.COMPLETED, YESTERDAY);
    const priorNoShow = await makeBooking(BookingStatus.NO_SHOW, YESTERDAY);
    const priorCancelled = await makeBooking(BookingStatus.CANCELLED, YESTERDAY);
    const priorBooked = await makeBooking(BookingStatus.BOOKED, YESTERDAY); // non-terminal -> stays
    const sameDayCompleted = await makeBooking(BookingStatus.COMPLETED, NOW); // same day -> stays

    const { archived } = await archival.runSweep(NOW);
    expect(archived).toBe(3);

    // the three prior-day terminal ones moved to history, gone from bookings
    for (const id of [priorCompleted, priorNoShow, priorCancelled]) {
      expect(await prisma.booking.findUnique({ where: { id } })).toBeNull();
      const h = await prisma.bookingHistory.findUnique({ where: { bookingId: id } });
      expect(h).not.toBeNull();
      expect(h?.clinicId).toBe(CLINIC_ID); // clinic resolved via doctor join
    }

    // prior-day non-terminal + same-day terminal remain in bookings, not in history
    for (const id of [priorBooked, sameDayCompleted]) {
      expect(await prisma.booking.findUnique({ where: { id } })).not.toBeNull();
      expect(await prisma.bookingHistory.findUnique({ where: { bookingId: id } })).toBeNull();
    }
  });

  it('job killed mid-batch: every booking is in exactly one table — none duplicated, none missing', async () => {
    const ids = [
      await makeBooking(BookingStatus.COMPLETED, YESTERDAY),
      await makeBooking(BookingStatus.NO_SHOW, YESTERDAY),
      await makeBooking(BookingStatus.CANCELLED, YESTERDAY),
      await makeBooking(BookingStatus.COMPLETED, YESTERDAY),
    ];

    // simulate the job dying after processing the first two (each move is its own txn)
    const due = await prisma.booking.findMany({
      where: { doctorId: DOCTOR_ID },
      include: { payment: true, doctor: { select: { clinicId: true } } },
      orderBy: { createdAt: 'asc' },
    });
    await archival.archiveOne(due[0]);
    await archival.archiveOne(due[1]);
    // <-- "killed" here; due[2], due[3] never processed

    // invariant: each booking lives in exactly ONE table
    for (const id of ids) {
      const inBookings = (await prisma.booking.findUnique({ where: { id } })) !== null;
      const inHistory =
        (await prisma.bookingHistory.findUnique({ where: { bookingId: id } })) !== null;
      expect(inBookings !== inHistory).toBe(true); // XOR: never both, never neither
    }

    // a resumed sweep archives exactly the remaining two
    const { archived } = await archival.runSweep(NOW);
    expect(archived).toBe(2);
    expect(await prisma.booking.count({ where: { doctorId: DOCTOR_ID } })).toBe(0);
    expect(await prisma.bookingHistory.count({ where: { doctorId: DOCTOR_ID } })).toBe(4);
  });

  it('a failed move rolls back atomically: the booking stays, history is not duplicated', async () => {
    const id = await makeBooking(BookingStatus.COMPLETED, YESTERDAY);
    const [booking] = await prisma.booking.findMany({
      where: { id },
      include: { payment: true, doctor: { select: { clinicId: true } } },
    });

    // force the history insert to fail: pre-seed a row with the same (unique) bookingId
    await prisma.bookingHistory.create({
      data: {
        bookingId: id,
        patientId: PATIENT_ID,
        doctorId: DOCTOR_ID,
        clinicId: CLINIC_ID,
        source: BookingSource.APP,
        sessionDate: YESTERDAY,
        sessionType: 'MORNING',
        finalStatus: BookingStatus.COMPLETED,
        bookedAt: YESTERDAY,
      },
    });

    await expect(archival.archiveOne(booking)).rejects.toThrow();

    // rollback proof: booking NOT deleted, and only the single pre-seeded history row exists
    expect(await prisma.booking.findUnique({ where: { id } })).not.toBeNull();
    expect(await prisma.bookingHistory.count({ where: { bookingId: id } })).toBe(1);
  });
});
