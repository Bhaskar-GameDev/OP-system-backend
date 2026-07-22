import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import {
  BookingSource,
  BookingStatus,
  EncounterStatus,
  RegistrationSource,
  SessionType,
  TokenResetPolicy,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RedisService } from '../src/common/redis/redis.service';
import { AuthTokenService } from '../src/auth/auth-token.service';
import { OpConfigService } from '../src/config-engine/op-config.service';
import { OpProjectionScheduler } from '../src/realtime/op-projection.scheduler';

/**
 * Cutover-sequence capstone. For a fully-flipped clinic, proves the compat layers
 * compose end to end for a REAL patient journey — the exact rollout a clinic runs:
 *
 *   app patient (register-only mirror)  --flipped reception roster-->  desk sees them
 *      --mark arrived (action-compat)-->  new token issued + enqueued
 *      --projection-->  patient /queue/my-status + doctor /op dashboard both reflect it
 *
 * This is what makes flipping a production clinic safe: every app reads the new
 * engine through the flags, unchanged.
 */
describe('Cutover sequence (flipped clinic, all compat layers together)', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let redis: RedisService;
  let config: OpConfigService;
  let scheduler: OpProjectionScheduler;

  const stamp = Date.now();
  const HOSP = `cs-hosp-${stamp}`;
  const CLINIC = `cs-clinic-${stamp}`;
  const DOCTOR = `cs-doc-${stamp}`;
  const SERIES = `cs-series-${stamp}`;
  const BOOKING = `cs-bk-${stamp}`;
  const MOBILE = '7000000009';
  const DATE = '2026-11-10';
  let staff = '';
  let doctorTok = '';
  let patientTok = '';
  let encId = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    config = app.get(OpConfigService);
    scheduler = app.get(OpProjectionScheduler);
    const tokens = app.get(AuthTokenService);

    await cleanup();
    await prisma.hospital.create({ data: { id: HOSP, name: 'CS Hosp' } });
    await prisma.clinic.create({ data: { id: CLINIC, hospitalId: HOSP, name: 'CS Clinic' } });
    await prisma.doctor.create({ data: { id: DOCTOR, clinicId: CLINIC, name: 'CS Dr', avgConsultMinutes: 10 } });
    await prisma.tokenSeries.create({ data: { id: SERIES, clinicId: CLINIC, code: 'NORMAL_OP', label: 'N', prefix: 'W', padWidth: 3, startAt: 1, resetPolicy: TokenResetPolicy.PER_SESSION } });
    const patient = await prisma.patient.create({ data: { mobile: MOBILE, name: 'CS Patient' } });

    // The dual-write state of an APP booking: a legacy Booking (phone/app token)
    // + a REGISTER-ONLY mirror encounter correlated by channelMeta (no column).
    await prisma.booking.create({ data: { id: BOOKING, patientId: patient.id, doctorId: DOCTOR, source: BookingSource.APP, sessionDate: new Date(DATE), sessionType: SessionType.MORNING, status: BookingStatus.BOOKED, tokenNumber: 'P001' } });
    const enc = await prisma.encounter.create({ data: { patientId: patient.id, hospitalId: HOSP, clinicId: CLINIC, doctorId: DOCTOR, serviceDate: new Date(DATE), opCategoryId: SERIES, status: EncounterStatus.REGISTERED } });
    encId = enc.id;
    await prisma.registration.create({ data: { encounterId: encId, source: RegistrationSource.APP, channelMeta: { legacyBookingId: BOOKING } } });

    // Flip the clinic: reception roster + patient status read from the new engine.
    await config.set('CLINIC', CLINIC, 'reads.cutover.roster', true);
    await config.set('CLINIC', CLINIC, 'reads.cutover.patientStatus', true);

    staff = tokens.sign({ sub: 'cs-staff', role: 'STAFF', clinicId: CLINIC, hospitalId: HOSP });
    doctorTok = tokens.sign({ sub: DOCTOR, role: 'DOCTOR', doctorId: DOCTOR, clinicId: CLINIC, hospitalId: HOSP });
    patientTok = tokens.sign({ sub: patient.id, role: 'PATIENT' });
  });

  afterAll(async () => {
    const sessions = await prisma.opSession.findMany({ where: { doctorId: DOCTOR }, select: { id: true } }).catch(() => [] as { id: string }[]);
    for (const s of sessions) {
      const keys = await redis.redis.keys(`pfos:*${s.id}*`).catch(() => [] as string[]);
      if (keys.length) await redis.redis.del(...keys);
    }
    const seq = await redis.redis.keys(`pfos:tokenseq:${SERIES}:*`).catch(() => [] as string[]);
    if (seq.length) await redis.redis.del(...seq);
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await prisma.hospitalConfig.deleteMany({ where: { scopeId: CLINIC } }).catch(() => {});
    const ids = (await prisma.encounter.findMany({ where: { doctorId: DOCTOR }, select: { id: true } }).catch(() => [] as { id: string }[])).map((e) => e.id);
    const w = { encounterId: { in: ids } };
    await prisma.queueEntry.deleteMany({ where: w }).catch(() => {});
    await prisma.token.deleteMany({ where: w }).catch(() => {});
    await prisma.checkIn.deleteMany({ where: w }).catch(() => {});
    await prisma.registration.deleteMany({ where: w }).catch(() => {});
    await prisma.queueReadModel.deleteMany({ where: w }).catch(() => {});
    await prisma.domainEvent.deleteMany({ where: { streamId: { in: ids } } }).catch(() => {});
    await prisma.encounter.deleteMany({ where: { doctorId: DOCTOR } }).catch(() => {});
    await prisma.opSession.deleteMany({ where: { doctorId: DOCTOR } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { id: BOOKING } }).catch(() => {});
    await prisma.patient.deleteMany({ where: { mobile: MOBILE } }).catch(() => {});
    await prisma.tokenSeries.deleteMany({ where: { id: SERIES } }).catch(() => {});
    await prisma.doctor.deleteMany({ where: { id: DOCTOR } }).catch(() => {});
    await prisma.clinic.deleteMany({ where: { id: CLINIC } }).catch(() => {});
    await prisma.hospital.deleteMany({ where: { id: HOSP } }).catch(() => {});
  }

  const get = (path: string, tok: string) => fetch(`${url}${path}`, { headers: { authorization: `Bearer ${tok}` } });
  const post = (path: string, tok: string, body?: unknown) => fetch(`${url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const patch = (path: string, tok: string, body: unknown) => fetch(`${url}${path}`, { method: 'PATCH', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('runs the full flipped-clinic journey: desk -> new token -> doctor + patient reads', async () => {
    // 1. The register-only app patient is VISIBLE on the flipped reception roster.
    const roster = (await (await get(`/reception/bookings?doctorId=${DOCTOR}&sessionDate=${DATE}&sessionType=MORNING`, staff)).json()) as { bookingId: string; tokenNumber: string | null }[];
    const row = roster.find((r) => r.bookingId === encId);
    expect(row).toBeDefined();
    expect(row!.tokenNumber).toBeNull(); // register-only, no token yet

    // 2. Reception marks them arrived -> new token issued + enqueued.
    const ci = await patch(`/reception/bookings/${encId}/checkin`, staff, { arrived: true });
    expect(ci.status).toBe(200);
    const token = await prisma.token.findUnique({ where: { encounterId: encId } });
    expect(token?.displayNumber).toMatch(/^W\d{3}$/); // NEW engine token
    expect(await prisma.queueEntry.findUnique({ where: { encounterId: encId } })).not.toBeNull();

    // 3. Project so the read models catch up.
    await scheduler.tick();

    // 4. Patient's own status (resolved via channelMeta) shows the NEW-engine queue.
    const mine = (await (await get(`/queue/my-status?bookingId=${BOOKING}`, patientTok)).json()) as { tokenNumber: string; position: number; status: string };
    expect(mine.tokenNumber).toBe(token!.displayNumber);
    expect(mine.position).toBe(1);

    // 5. Doctor's dashboard shows the same patient waiting.
    const dash = (await (await get(`/op/doctors/${DOCTOR}/dashboard`, doctorTok)).json()) as { waiting: { encounterId: string }[] };
    expect(dash.waiting.some((r) => r.encounterId === encId)).toBe(true);

    // 6. Doctor calls them in -> patient status flips to being seen.
    const opSessionId = (await prisma.queueEntry.findUniqueOrThrow({ where: { encounterId: encId } })).opSessionId;
    expect((await post(`/op/sessions/${opSessionId}/call-next`, doctorTok)).status).toBe(201);
    await post(`/op/encounters/${encId}/start`, doctorTok, {});
    await scheduler.tick();
    const seen = (await (await get(`/queue/my-status?bookingId=${BOOKING}`, patientTok)).json()) as { status: string };
    expect(seen.status).toBe('in_consultation');
  });
});
