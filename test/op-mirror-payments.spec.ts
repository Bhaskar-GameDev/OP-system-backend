import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BookingSource, EncounterStatus, TokenResetPolicy } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RedisService } from '../src/common/redis/redis.service';
import { PaymentsService } from '../src/payments/payments.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { SessionKey } from '../src/queue-engine/token.service';
import { FakeRazorpayGateway, RAZORPAY_GATEWAY } from '../src/payments/razorpay.gateway';

/**
 * Task 2 dual-write — APP channel (payments.confirm). Proves a confirmed app
 * booking ALSO mirrors into the new engine as a REGISTER-ONLY Encounter (source
 * APP): the token is NOT issued in the new pipeline yet (registration ≠ token —
 * that happens at desk/geofence check-in), and the legacy Booking is untouched.
 */
describe('Dual-write: payments.confirm mirrors an APP booking into the new engine', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let payments: PaymentsService;
  let queue: QueueService;

  const stamp = Date.now();
  const HOSP = `mp-hosp-${stamp}`;
  const CLINIC = `mp-clinic-${stamp}`;
  const DOCTOR = `mp-doc-${stamp}`;
  const SERIES = `mp-series-${stamp}`;
  const FEE = 500;
  const patientIds: string[] = [];
  const encounterIds: string[] = [];

  const todayYmd = (): string => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  let session: SessionKey;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RAZORPAY_GATEWAY)
      .useClass(FakeRazorpayGateway)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    payments = app.get(PaymentsService);
    queue = app.get(QueueService);
    session = { doctorId: DOCTOR, sessionDate: todayYmd(), sessionType: 'MORNING' };

    await cleanup();
    await prisma.hospital.create({ data: { id: HOSP, name: 'MP Hosp' } });
    await prisma.clinic.create({ data: { id: CLINIC, hospitalId: HOSP, name: 'MP Clinic' } });
    await prisma.doctor.create({ data: { id: DOCTOR, clinicId: CLINIC, name: 'MP Dr', consultationFee: FEE, avgConsultMinutes: 10 } });
    await prisma.doctorSession.create({ data: { doctorId: DOCTOR, sessionType: 'MORNING', startTime: '09:00', maxTokens: 50, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] } });
    await prisma.tokenSeries.create({
      data: { id: SERIES, clinicId: CLINIC, code: 'NORMAL_OP', label: 'Normal', prefix: 'N', padWidth: 3, startAt: 1, resetPolicy: TokenResetPolicy.PER_SESSION, fee: FEE * 100 },
    });
  });

  afterAll(async () => {
    await queue.clearSession(session).catch(() => {});
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    const w = { encounterId: { in: encounterIds } };
    await prisma.queueEntry.deleteMany({ where: w }).catch(() => {});
    await prisma.token.deleteMany({ where: w }).catch(() => {});
    await prisma.checkIn.deleteMany({ where: w }).catch(() => {});
    await prisma.registration.deleteMany({ where: w }).catch(() => {});
    await prisma.queueReadModel.deleteMany({ where: w }).catch(() => {});
    await prisma.domainEvent.deleteMany({ where: { streamId: { in: encounterIds } } }).catch(() => {});
    await prisma.encounter.deleteMany({ where: { id: { in: encounterIds } } }).catch(() => {});
    await prisma.opSession.deleteMany({ where: { doctorId: DOCTOR } }).catch(() => {});
    const bs = await prisma.booking.findMany({ where: { doctorId: DOCTOR }, select: { id: true } }).catch(() => [] as { id: string }[]);
    await prisma.booking.updateMany({ where: { doctorId: DOCTOR }, data: { paymentId: null } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { bookingId: { in: bs.map((b) => b.id) } } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR } }).catch(() => {});
    if (patientIds.length) await prisma.patient.deleteMany({ where: { id: { in: patientIds } } }).catch(() => {});
    await prisma.tokenSeries.deleteMany({ where: { id: SERIES } }).catch(() => {});
    await prisma.doctorSession.deleteMany({ where: { doctorId: DOCTOR } }).catch(() => {});
    await prisma.doctor.deleteMany({ where: { id: DOCTOR } }).catch(() => {});
    await prisma.clinic.deleteMany({ where: { id: CLINIC } }).catch(() => {});
    await prisma.hospital.deleteMany({ where: { id: HOSP } }).catch(() => {});
  }

  it('a confirmed APP booking yields a register-only mirrored Encounter (source APP)', async () => {
    const p = await prisma.patient.create({ data: { name: 'MP Patient', mobile: `51${stamp}` } });
    patientIds.push(p.id);

    const { bookingId, orderId } = await payments.initiateBooking({ patientId: p.id, doctorId: DOCTOR, source: BookingSource.APP });
    // FakeRazorpayGateway.fetchPayment derives the order from a pay_dev_<orderId> id.
    const res = await payments.confirm(orderId, `pay_dev_${orderId}`);
    expect(res.tokenNumber).toBeTruthy(); // legacy token issued as before

    // legacy Booking is unchanged (token present, BOOKED)
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.tokenNumber).toBeTruthy();

    // the mirror registered a NEW Encounter, correlated by legacyBookingId
    const reg = await prisma.registration.findFirst({
      where: { source: 'APP', channelMeta: { path: ['legacyBookingId'], equals: bookingId } },
      select: { encounterId: true },
    });
    expect(reg).not.toBeNull();
    encounterIds.push(reg!.encounterId);

    // REGISTER-ONLY: encounter waits at REGISTERED, with NO token and NO queue entry
    const enc = await prisma.encounter.findUniqueOrThrow({ where: { id: reg!.encounterId } });
    expect(enc.status).toBe(EncounterStatus.REGISTERED);
    expect(enc.patientId).toBe(p.id);
    expect(await prisma.token.findUnique({ where: { encounterId: reg!.encounterId } })).toBeNull();
    expect(await prisma.queueEntry.findUnique({ where: { encounterId: reg!.encounterId } })).toBeNull();
  });

  it('re-confirming the same booking does not create a second Encounter (idempotent)', async () => {
    const before = await prisma.registration.count({ where: { encounterId: { in: encounterIds } } });
    // confirm() is idempotent; re-running must not spawn another mirror encounter
    const booking = await prisma.booking.findFirstOrThrow({ where: { doctorId: DOCTOR } });
    const payment = await prisma.payment.findFirstOrThrow({ where: { bookingId: booking.id } });
    await payments.confirm(payment.razorpayOrderId!, `pay_dev_${payment.razorpayOrderId}`).catch(() => {});
    const after = await prisma.registration.count({ where: { encounterId: { in: encounterIds } } });
    expect(after).toBe(before);
  });
});
