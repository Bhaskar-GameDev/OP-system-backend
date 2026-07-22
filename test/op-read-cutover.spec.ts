import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import {
  BookingSource,
  BookingStatus,
  CheckInMethod,
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

/**
 * Task 5 read cutover (reversible, flagged). The reception roster endpoint serves
 * the SAME BookingRosterView whether it reads legacy Bookings (flag off, default)
 * or the new aggregates (flag on) — proving a clinic can be flipped to new-engine
 * reads with no change to the reception app's wire contract, and flipped back.
 */
describe('Reception roster read cutover (flag off == flag on shape)', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let redis: RedisService;
  let config: OpConfigService;

  const stamp = Date.now();
  const HOSP = `rc-hosp-${stamp}`;
  const CLINIC = `rc-clinic-${stamp}`;
  const DOCTOR = `rc-doc-${stamp}`;
  const SERIES = `rc-series-${stamp}`;
  const BOOKING = `rc-bk-${stamp}`;
  const DATE = '2026-10-05';
  const MOBILE = '7600000001';
  const MOBILE2 = '7600000002';
  const MOBILE3 = '7600000003';
  const FEE = 40000;
  let encounterId = '';
  let enc2Id = ''; // new-native: no legacy booking, roster bookingId === encounterId
  let enc3Id = ''; // register-only: no token yet (app/voice mirror), checked in at desk
  let staff = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    config = app.get(OpConfigService);
    staff = app.get(AuthTokenService).sign({ sub: 'rc-staff', role: 'STAFF', clinicId: CLINIC, hospitalId: HOSP });

    await cleanup();
    await prisma.hospital.create({ data: { id: HOSP, name: 'RC Hosp' } });
    await prisma.clinic.create({ data: { id: CLINIC, hospitalId: HOSP, name: 'RC Clinic' } });
    await prisma.doctor.create({ data: { id: DOCTOR, clinicId: CLINIC, name: 'RC Dr', avgConsultMinutes: 10 } });
    await prisma.tokenSeries.create({ data: { id: SERIES, clinicId: CLINIC, code: 'NORMAL_OP', label: 'N', prefix: 'W', padWidth: 3, startAt: 1, resetPolicy: TokenResetPolicy.PER_SESSION, fee: FEE } });
    const patient = await prisma.patient.create({ data: { mobile: MOBILE, name: 'RC Patient' } });

    // Legacy walk-in booking (what the flag-off path serves).
    await prisma.booking.create({
      data: { id: BOOKING, patientId: patient.id, doctorId: DOCTOR, source: BookingSource.WALK_IN, sessionDate: new Date(DATE), sessionType: SessionType.MORNING, status: BookingStatus.BOOKED, tokenNumber: 'W005', checkedInAt: new Date(DATE) },
    });

    // Its new-engine equivalent (what the flag-on path serves), correlated by legacyBookingId.
    const enc = await prisma.encounter.create({
      data: { patientId: patient.id, hospitalId: HOSP, clinicId: CLINIC, doctorId: DOCTOR, serviceDate: new Date(DATE), opCategoryId: SERIES, status: EncounterStatus.WAITING, legacyBookingId: BOOKING },
    });
    encounterId = enc.id;
    await prisma.registration.create({ data: { encounterId, source: RegistrationSource.RECEPTION } });
    await prisma.token.create({ data: { encounterId, seriesId: SERIES, sequence: 5, displayNumber: 'W005' } });
    await prisma.checkIn.create({ data: { encounterId, method: CheckInMethod.DESK, checkedInAt: new Date(DATE) } });

    // A NEW-NATIVE token-holder with NO legacy booking (roster bookingId === encounterId).
    const p2 = await prisma.patient.create({ data: { mobile: MOBILE2, name: 'RC Native' } });
    const enc2 = await prisma.encounter.create({
      data: { patientId: p2.id, hospitalId: HOSP, clinicId: CLINIC, doctorId: DOCTOR, serviceDate: new Date(DATE), opCategoryId: SERIES, status: EncounterStatus.TOKEN_ISSUED },
    });
    enc2Id = enc2.id;
    await prisma.registration.create({ data: { encounterId: enc2Id, source: RegistrationSource.APP } });
    await prisma.token.create({ data: { encounterId: enc2Id, seriesId: SERIES, sequence: 6, displayNumber: 'W006' } });
    await prisma.checkIn.create({ data: { encounterId: enc2Id, method: CheckInMethod.DESK, checkedInAt: new Date(DATE) } });

    // A REGISTER-ONLY encounter (app/voice mirror): NO token, NOT in the queue —
    // the desk must still see it on a flipped roster to process it.
    const p3 = await prisma.patient.create({ data: { mobile: MOBILE3, name: 'RC Pending' } });
    const enc3 = await prisma.encounter.create({
      data: { patientId: p3.id, hospitalId: HOSP, clinicId: CLINIC, doctorId: DOCTOR, serviceDate: new Date(DATE), opCategoryId: SERIES, status: EncounterStatus.REGISTERED },
    });
    enc3Id = enc3.id;
    await prisma.registration.create({ data: { encounterId: enc3Id, source: RegistrationSource.APP } });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await prisma.hospitalConfig.deleteMany({ where: { scopeId: CLINIC } }).catch(() => {});
    const sessions = await prisma.opSession.findMany({ where: { doctorId: DOCTOR }, select: { id: true } }).catch(() => [] as { id: string }[]);
    for (const s of sessions) {
      const keys = await redis.redis.keys(`pfos:*${s.id}*`).catch(() => [] as string[]);
      if (keys.length) await redis.redis.del(...keys);
    }
    const seq = await redis.redis.keys(`pfos:tokenseq:${SERIES}:*`).catch(() => [] as string[]);
    if (seq.length) await redis.redis.del(...seq);
    const ids = (await prisma.encounter.findMany({ where: { doctorId: DOCTOR }, select: { id: true } }).catch(() => [] as { id: string }[])).map((e) => e.id);
    const w = { encounterId: { in: ids } };
    await prisma.queueEntry.deleteMany({ where: w }).catch(() => {});
    await prisma.opPayment.deleteMany({ where: w }).catch(() => {});
    await prisma.token.deleteMany({ where: w }).catch(() => {});
    await prisma.checkIn.deleteMany({ where: w }).catch(() => {});
    await prisma.registration.deleteMany({ where: w }).catch(() => {});
    await prisma.domainEvent.deleteMany({ where: { streamId: { in: ids } } }).catch(() => {});
    await prisma.encounter.deleteMany({ where: { doctorId: DOCTOR } }).catch(() => {});
    await prisma.opSession.deleteMany({ where: { doctorId: DOCTOR } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { id: BOOKING } }).catch(() => {});
    await prisma.patient.deleteMany({ where: { mobile: { in: [MOBILE, MOBILE2, MOBILE3] } } }).catch(() => {});
    await prisma.tokenSeries.deleteMany({ where: { id: SERIES } }).catch(() => {});
    await prisma.doctor.deleteMany({ where: { id: DOCTOR } }).catch(() => {});
    await prisma.clinic.deleteMany({ where: { id: CLINIC } }).catch(() => {});
    await prisma.hospital.deleteMany({ where: { id: HOSP } }).catch(() => {});
  }

  interface RosterRow { bookingId: string; tokenNumber: string | null; patientName: string; source: string; status: string; arrived: boolean; }

  async function roster(): Promise<RosterRow[]> {
    const res = await fetch(`${url}/reception/bookings?doctorId=${DOCTOR}&sessionDate=${DATE}&sessionType=MORNING`, {
      headers: { authorization: `Bearer ${staff}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as RosterRow[];
  }

  it('flag OFF (default): serves the legacy Booking roster', async () => {
    const rows = await roster();
    const row = rows.find((r) => r.tokenNumber === 'W005');
    expect(row).toBeDefined();
    expect(row!.bookingId).toBe(BOOKING);
    expect(row!.status).toBe('BOOKED');
    expect(row!.source).toBe('WALK_IN');
    expect(row!.arrived).toBe(true);
  });

  it('flag ON: serves the same shape from the new aggregates', async () => {
    await config.set('CLINIC', CLINIC, 'reads.cutover.roster', true);
    const rows = await roster();
    const row = rows.find((r) => r.tokenNumber === 'W005');
    expect(row).toBeDefined();
    // same wire contract, now sourced from Encounter+Token+CheckIn+Registration
    expect(row!.bookingId).toBe(BOOKING); // legacyBookingId preserved for app actions
    expect(row!.patientName).toBe('RC Patient');
    expect(row!.source).toBe('WALK_IN'); // RECEPTION -> WALK_IN
    expect(row!.status).toBe('BOOKED'); // WAITING -> BOOKED
    expect(row!.arrived).toBe(true); // CheckIn present
  });

  it('flag flips back (reversible): OFF again returns to legacy read', async () => {
    await config.set('CLINIC', CLINIC, 'reads.cutover.roster', false);
    const rows = await roster();
    expect(rows.find((r) => r.tokenNumber === 'W005')).toBeDefined();
  });

  // ── action-compat: legacy reception actions on a new-native encounterId ──

  function patchCheckin(id: string, arrived: boolean) {
    return fetch(`${url}/reception/bookings/${id}/checkin`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${staff}`, 'content-type': 'application/json' },
      body: JSON.stringify({ arrived }),
    });
  }
  function collect(id: string) {
    return fetch(`${url}/reception/bookings/${id}/collect-payment`, {
      method: 'POST',
      headers: { authorization: `Bearer ${staff}` },
    });
  }

  it('check-in on a new-native encounterId routes to the token engine (idempotent)', async () => {
    const res = await patchCheckin(enc2Id, true);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; arrived: boolean };
    expect(body.id).toBe(enc2Id);
    expect(body.arrived).toBe(true);
  });

  it('un-arrive on a new-native encounter is a 409 (forward-only engine)', async () => {
    const res = await patchCheckin(enc2Id, false);
    expect(res.status).toBe(409);
  });

  it('collect-payment on a new-native encounter settles a decoupled OpPayment (CASH), idempotent', async () => {
    const res = await collect(enc2Id);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { bookingId: string; paid: boolean; amountPaise: number };
    expect(body.paid).toBe(true);
    expect(body.amountPaise).toBe(FEE);

    const pay = await prisma.opPayment.findFirst({ where: { encounterId: enc2Id, status: 'SUCCESS' } });
    expect(pay).not.toBeNull();

    // idempotent — a second collect does not double-charge
    const again = await collect(enc2Id);
    expect(((await again.json()) as { amountPaise: number }).amountPaise).toBe(FEE);
    expect(await prisma.opPayment.count({ where: { encounterId: enc2Id, status: 'SUCCESS' } })).toBe(1);
  });

  // ── the gap-closer: register-only (pre-token) patients on a flipped desk ──

  it('flipped roster surfaces a register-only encounter with no token yet', async () => {
    await config.set('CLINIC', CLINIC, 'reads.cutover.roster', true);
    const rows = await roster();
    const pending = rows.find((r) => r.bookingId === enc3Id);
    expect(pending).toBeDefined();
    expect(pending!.tokenNumber).toBeNull(); // not tokenised yet
    await config.set('CLINIC', CLINIC, 'reads.cutover.roster', false);
  });

  it('marking a register-only encounter arrived issues its token and enqueues it', async () => {
    // pre-condition: no token, not in the queue
    expect(await prisma.token.findUnique({ where: { encounterId: enc3Id } })).toBeNull();

    const res = await patchCheckin(enc3Id, true);
    expect(res.status).toBe(200);

    // now fully processed into the new engine: token issued + queue entry + WAITING
    const token = await prisma.token.findUnique({ where: { encounterId: enc3Id } });
    expect(token?.displayNumber).toMatch(/^W\d{3}$/);
    expect(await prisma.queueEntry.findUnique({ where: { encounterId: enc3Id } })).not.toBeNull();
    expect((await prisma.encounter.findUniqueOrThrow({ where: { id: enc3Id } })).status).toBe(EncounterStatus.WAITING);
  });
});
