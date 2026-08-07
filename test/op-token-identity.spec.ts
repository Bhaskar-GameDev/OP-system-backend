import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import {
  BookingSource,
  BookingStatus,
  CheckInMethod,
  EncounterStatus,
  QueuePolicyMode,
  RegistrationSource,
  SessionType,
  TokenResetPolicy,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RedisService } from '../src/common/redis/redis.service';
import { AuthTokenService } from '../src/auth/auth-token.service';
import { OpConfigService } from '../src/config-engine/op-config.service';
import { CheckInService } from '../src/check-in/checkin.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { OpProjectionScheduler } from '../src/realtime/op-projection.scheduler';
import { SessionKey } from '../src/queue-engine/token.service';

/**
 * ONE number per visit, across both engines.
 *
 * During the dual-write cutover a single visit exists as a legacy Booking AND a
 * new Encounter. Before this was fixed each engine minted independently, so the
 * same patient was W001 on the doctor's screen and N001 on the desk's — decided
 * by which surface had its cutover flag set. The rule these tests pin down is:
 * whichever engine first quotes a number to a human owns it, the other carries it.
 *
 * Walk-in and voice: nothing has been said to the patient when the desk hits
 * register, so OP mints and the legacy queue carries OP's number.
 * App booking: the patient saw a number the moment payment succeeded, so OP
 * adopts THAT at check-in rather than minting a second one.
 */
describe('OP cutover: one token identity per visit', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let redis: RedisService;
  let config: OpConfigService;
  let checkIn: CheckInService;
  let queue: QueueService;
  let scheduler: OpProjectionScheduler;

  const stamp = Date.now();
  const HOSP = `ti-hosp-${stamp}`;
  const CLINIC = `ti-clinic-${stamp}`;
  const DOCTOR = `ti-doc-${stamp}`;
  const SERIES = `ti-series-${stamp}`;
  const APP_BOOKING = `ti-appbk-${stamp}`;
  const DATE = new Date().toISOString().slice(0, 10); // doctor queue is TODAY-only
  const WALKIN_MOBILE = '7710000001';
  const APP_MOBILE = '7710000002';

  let staff = '';
  let doctorToken = '';
  const session: SessionKey = {
    doctorId: DOCTOR,
    sessionDate: DATE,
    sessionType: 'MORNING',
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    config = app.get(OpConfigService);
    checkIn = app.get(CheckInService);
    queue = app.get(QueueService);
    scheduler = app.get(OpProjectionScheduler);

    const auth = app.get(AuthTokenService);
    staff = auth.sign({ sub: 'ti-staff', role: 'STAFF', clinicId: CLINIC, hospitalId: HOSP });
    doctorToken = auth.sign({ sub: DOCTOR, role: 'DOCTOR', clinicId: CLINIC, hospitalId: HOSP });

    await cleanup();
    await prisma.hospital.create({ data: { id: HOSP, name: 'TI Hosp' } });
    await prisma.clinic.create({ data: { id: CLINIC, hospitalId: HOSP, name: 'TI Clinic' } });
    await prisma.doctor.create({
      data: { id: DOCTOR, clinicId: CLINIC, name: 'TI Dr', avgConsultMinutes: 10 },
    });
    // Prefix N: deliberately DIFFERENT from the legacy walk-in prefix (W), so a
    // shared number can only mean one engine adopted the other's.
    await prisma.tokenSeries.create({
      data: {
        id: SERIES,
        clinicId: CLINIC,
        code: 'NORMAL_OP',
        label: 'Normal',
        prefix: 'N',
        padWidth: 3,
        startAt: 1,
        resetPolicy: TokenResetPolicy.PER_SESSION,
        fee: 40000,
      },
    });
    await prisma.queuePolicy.create({
      data: { clinicId: CLINIC, mode: QueuePolicyMode.SHARED_FIFO, ratio: {} },
    });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await prisma.hospitalConfig.deleteMany({ where: { scopeId: CLINIC } }).catch(() => {});
    const keys = await redis.redis.keys(`pfos:*${DOCTOR}*`).catch(() => [] as string[]);
    if (keys.length) await redis.redis.del(...keys);
    const seq = await redis.redis.keys(`pfos:tokenseq:${SERIES}:*`).catch(() => [] as string[]);
    if (seq.length) await redis.redis.del(...seq);
    const ids = (
      await prisma.encounter
        .findMany({ where: { doctorId: DOCTOR }, select: { id: true } })
        .catch(() => [] as { id: string }[])
    ).map((e) => e.id);
    const w = { encounterId: { in: ids } };
    await prisma.queueReadModel.deleteMany({ where: { doctorId: DOCTOR } }).catch(() => {});
    await prisma.queueEntry.deleteMany({ where: w }).catch(() => {});
    await prisma.opPayment.deleteMany({ where: w }).catch(() => {});
    await prisma.token.deleteMany({ where: w }).catch(() => {});
    await prisma.checkIn.deleteMany({ where: w }).catch(() => {});
    await prisma.registration.deleteMany({ where: w }).catch(() => {});
    await prisma.domainEvent.deleteMany({ where: { streamId: { in: ids } } }).catch(() => {});
    await prisma.encounter.deleteMany({ where: { doctorId: DOCTOR } }).catch(() => {});
    await prisma.opSession.deleteMany({ where: { doctorId: DOCTOR } }).catch(() => {});
    await prisma.queuePolicy.deleteMany({ where: { clinicId: CLINIC } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR } }).catch(() => {});
    await prisma.patient
      .deleteMany({ where: { mobile: { in: [WALKIN_MOBILE, APP_MOBILE] } } })
      .catch(() => {});
    await prisma.tokenSeries.deleteMany({ where: { id: SERIES } }).catch(() => {});
    await prisma.doctor.deleteMany({ where: { id: DOCTOR } }).catch(() => {});
    await prisma.clinic.deleteMany({ where: { id: CLINIC } }).catch(() => {});
    await prisma.hospital.deleteMany({ where: { id: HOSP } }).catch(() => {});
  }

  /**
   * bookingId -> encounterId, the same two-step the production code uses
   * (OpDoctorService.resolveBookingId): the backfill sets the Encounter column,
   * but the dual-write mirror only records it in Registration.channelMeta.
   */
  async function encounterForBooking(bookingId: string): Promise<string | null> {
    const byColumn = await prisma.encounter.findFirst({
      where: { legacyBookingId: bookingId },
      select: { id: true },
    });
    if (byColumn) return byColumn.id;
    const reg = await prisma.registration.findFirst({
      where: {
        channelMeta: { path: ['legacyBookingId'], equals: bookingId },
      },
      select: { encounterId: true },
    });
    return reg?.encounterId ?? null;
  }

  interface DoctorQueue {
    activeToken: string | null;
    total: number;
    entries: { tokenNumber: string; patientName: string | null; isActive: boolean }[];
  }

  async function doctorQueue(): Promise<DoctorQueue> {
    const res = await fetch(`${url}/doctor/queue?sessionType=MORNING`, {
      headers: { authorization: `Bearer ${doctorToken}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as DoctorQueue;
  }

  it('walk-in: the OP token is the ONE number in both engines', async () => {
    const res = await fetch(`${url}/reception/walkins`, {
      method: 'POST',
      headers: { authorization: `Bearer ${staff}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mobile: WALKIN_MOBILE, name: 'TI Walkin', ...session }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { bookingId: string; tokenNumber: string };

    // OP minted it, so it carries the OP series prefix — NOT the legacy W.
    expect(body.tokenNumber).toMatch(/^N\d{3}$/);

    // 1. what the desk was told  2. the legacy Booking row  3. the legacy Redis
    // queue (what the un-flipped doctor screen renders)  4. the OP token.
    const booking = await prisma.booking.findUniqueOrThrow({
      where: { id: body.bookingId },
      select: { tokenNumber: true },
    });
    const inQueue = await queue.listWithScores(session);
    const encId = await encounterForBooking(body.bookingId);
    expect(encId).not.toBeNull();
    const opToken = await prisma.token.findUniqueOrThrow({
      where: { encounterId: encId! },
      select: { displayNumber: true },
    });

    expect(booking.tokenNumber).toBe(body.tokenNumber);
    expect(inQueue.map((s) => s.tokenNumber)).toContain(body.tokenNumber);
    expect(opToken.displayNumber).toBe(body.tokenNumber);
  });

  it('walk-in: the doctor sees that same number with the flag OFF', async () => {
    const q = await doctorQueue();
    const booking = await prisma.booking.findFirstOrThrow({
      where: { doctorId: DOCTOR, source: BookingSource.WALK_IN },
      select: { tokenNumber: true },
    });
    expect(q.entries.map((e) => e.tokenNumber)).toContain(booking.tokenNumber!);
  });

  it('app booking: OP adopts the number the patient was already shown', async () => {
    // An app booking as payment-confirm leaves it: legacy token issued and
    // displayed in the app; the OP encounter registered but NOT yet checked in.
    const patient = await prisma.patient.create({
      data: { mobile: APP_MOBILE, name: 'TI App' },
    });
    await prisma.booking.create({
      data: {
        id: APP_BOOKING,
        patientId: patient.id,
        doctorId: DOCTOR,
        source: BookingSource.APP,
        sessionDate: new Date(DATE),
        sessionType: SessionType.MORNING,
        status: BookingStatus.BOOKED,
        tokenNumber: 'A007',
      },
    });
    const enc = await prisma.encounter.create({
      data: {
        patientId: patient.id,
        hospitalId: HOSP,
        clinicId: CLINIC,
        doctorId: DOCTOR,
        serviceDate: new Date(DATE),
        opCategoryId: SERIES,
        status: EncounterStatus.REGISTERED,
        legacyBookingId: APP_BOOKING,
      },
    });
    await prisma.registration.create({
      data: { encounterId: enc.id, source: RegistrationSource.APP },
    });

    // Desk check-in issues the OP token. It must NOT mint N00x alongside A007.
    const result = await checkIn.checkIn(enc.id, CheckInMethod.DESK, {
      checkedInBy: 'reception',
      issueToken: true,
    });
    expect(result.token?.displayNumber).toBe('A007');
  });

  it('a register-only encounter with no legacy row still mints its own', async () => {
    // The post-teardown behaviour: nothing to adopt, so the series mints normally.
    const patient = await prisma.patient.findFirstOrThrow({
      where: { mobile: WALKIN_MOBILE },
    });
    const enc = await prisma.encounter.create({
      data: {
        patientId: patient.id,
        hospitalId: HOSP,
        clinicId: CLINIC,
        doctorId: DOCTOR,
        serviceDate: new Date(DATE),
        opCategoryId: SERIES,
        status: EncounterStatus.REGISTERED,
      },
    });
    await prisma.registration.create({
      data: { encounterId: enc.id, source: RegistrationSource.APP },
    });
    const result = await checkIn.checkIn(enc.id, CheckInMethod.DESK, {
      issueToken: true,
    });
    expect(result.token?.displayNumber).toMatch(/^N\d{3}$/);
  });

  it('doctor queue: flipping reads.cutover.doctorQueue keeps the same tokens', async () => {
    const before = await doctorQueue();
    // Guard against a vacuous pass: [] === [] would satisfy every assertion
    // below while proving the flipped read returns nothing at all.
    expect(before.entries.length).toBeGreaterThan(0);

    await config.set('CLINIC', CLINIC, 'reads.cutover.doctorQueue', true);
    await scheduler.drain(); // projection must have caught up before we read it
    const after = await doctorQueue();

    // The whole point of the flag: same numbers, same wire shape, either side.
    expect(after.entries.map((e) => e.tokenNumber).sort()).toEqual(
      before.entries.map((e) => e.tokenNumber).sort(),
    );
    for (const e of after.entries) {
      expect(e).toHaveProperty('patientName');
      expect(e).toHaveProperty('isActive');
    }

    await config.set('CLINIC', CLINIC, 'reads.cutover.doctorQueue', false);
    const reverted = await doctorQueue();
    expect(reverted.entries.map((e) => e.tokenNumber).sort()).toEqual(
      before.entries.map((e) => e.tokenNumber).sort(),
    );
  });
});
