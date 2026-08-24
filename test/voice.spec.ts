// Voice secret MUST be set before the app (ConfigModule) boots.
process.env.VOICE_INTERNAL_SECRET = 'test-voice-secret';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import {
  BookingStatus,
  EncounterStatus,
  PaymentStatus,
  SessionType,
  TokenResetPolicy,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthTokenService } from '../src/auth/auth-token.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { ConsultationService } from '../src/queue-engine/consultation.service';
import { SessionKey, TokenSource } from '../src/queue-engine/token.service';
import { OpQueueService } from '../src/queue/op-queue.service';

/**
 * Voice (phone) booking API end-to-end against real Postgres + Redis. Proves the
 * agent contract works: DID->clinic routing, pay-at-desk token issue, idempotent
 * booking, lookup, cancel + audit, call-log, the x-voice-secret gate, and the
 * reception desk settling the pay-at-desk payment.
 *
 * Post-cutover (2026-07-26): the token quoted to the caller is the OP engine's
 * `displayNumber`, minted from the clinic's TokenSeries — NOT a legacy queue
 * token. The legacy Booking is kept as the correlation + refund/audit anchor with
 * the OP token copied onto it, and voice bookings no longer enter the legacy
 * Redis queue at all. Hence the seeded TokenSeries below, and the `N###`
 * expectations (the legacy filler walk-in still mints `W001`).
 */
describe('Voice API (/voice) — real infra', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let queue: QueueService;
  let opQueue: OpQueueService;

  const SECRET = 'test-voice-secret';
  const HOSP = 'vc-hosp';
  const CLINIC = 'vc-clinic';
  const DID = '+910000000001';
  const DOCTOR = 'vc-doctor';
  const PHONE = '9300009001';
  const FILLER_PHONE = '9300009002';
  const SERIES = 'vc-series';

  let staffToken = '';
  let session: SessionKey;
  /**
   * The OP token minted for the caller, captured on first booking. NOT hardcoded:
   * the series counter is keyed per clinic/session and survives in Redis across
   * runs, so the exact number varies. What matters is the FORMAT (the seeded
   * NORMAL_OP series: prefix N, padWidth 3) and that every later read — repeat
   * call, lookup, the legacy booking row — quotes this same number.
   */
  let opToken = '';

  const todayYmd = (): string => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    queue = app.get(QueueService);
    opQueue = app.get(OpQueueService);

    // Deterministic session key so cleanup can wipe stale Redis (queue + token
    // counters) from a prior run BEFORE we seed — same-day always resolves here.
    session = { doctorId: DOCTOR, sessionDate: todayYmd(), sessionType: 'MORNING' };
    await cleanup();
    await prisma.hospital.create({ data: { id: HOSP, name: 'VC Hospital' } });
    await prisma.clinic.create({ data: { id: CLINIC, hospitalId: HOSP, name: 'VC Clinic' } });
    await prisma.voiceNumber.create({ data: { didNumber: DID, clinicId: CLINIC } });
    await prisma.doctor.create({
      data: { id: DOCTOR, clinicId: CLINIC, name: 'Dr Voice', specialization: 'Cardiology', consultationFee: 400, avgConsultMinutes: 10 },
    });
    // Same-day joinable session every day so resolveToday is OPEN on any run day.
    await prisma.doctorSession.create({
      data: { doctorId: DOCTOR, sessionType: SessionType.MORNING, startTime: '09:00', maxTokens: 20, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] },
    });
    // The OP engine mints the caller's token from this series. Without it the
    // mirror cannot raise a token and `book` 409s by design.
    await prisma.tokenSeries.create({
      data: { id: SERIES, clinicId: CLINIC, code: 'NORMAL_OP', label: 'Normal', prefix: 'N', padWidth: 3, startAt: 1, resetPolicy: TokenResetPolicy.PER_SESSION },
    });

    staffToken = app.get(AuthTokenService).sign({ sub: 'vc-staff', role: 'STAFF', clinicId: CLINIC, hospitalId: HOSP });

    // Pre-fill the queue with a walk-in so it isn't empty: that filler promotes to
    // ACTIVE at rank 0, leaving the later VOICE token at BOOKED (cancellable) — the
    // realistic case. (A lone first booking would auto-promote to ACTIVE.)
    const consult = app.get(ConsultationService);
    const today = todayYmd();
    const fp = await prisma.patient.create({ data: { mobile: FILLER_PHONE, name: 'Filler' }, select: { id: true } });
    const fb = await prisma.booking.create({
      data: { patientId: fp.id, doctorId: DOCTOR, source: 'WALK_IN', sessionDate: new Date(today), sessionType: SessionType.MORNING, status: BookingStatus.BOOKED },
      select: { id: true },
    });
    await consult.enqueueBooking(TokenSource.WALK_IN, { doctorId: DOCTOR, sessionDate: today, sessionType: 'MORNING' }, fb.id);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    if (session) await queue.clearSession(session).catch(() => undefined);
    await prisma.voiceCallLog.deleteMany({ where: { callSid: { in: ['call-1', 'log-1'] } } });
    await prisma.auditLog.deleteMany({ where: { doctorId: DOCTOR } });
    // OP-side rows the mirror now creates (encounter + token + queue entry).
    const encs = await prisma.encounter
      .findMany({ where: { doctorId: DOCTOR }, select: { id: true } })
      .catch(() => [] as { id: string }[]);
    const encIds = encs.map((e) => e.id);
    const w = { encounterId: { in: encIds } };
    await prisma.queueEntry.deleteMany({ where: w }).catch(() => undefined);
    await prisma.token.deleteMany({ where: w }).catch(() => undefined);
    await prisma.checkIn.deleteMany({ where: w }).catch(() => undefined);
    await prisma.registration.deleteMany({ where: w }).catch(() => undefined);
    await prisma.queueReadModel.deleteMany({ where: w }).catch(() => undefined);
    await prisma.domainEvent.deleteMany({ where: { streamId: { in: encIds } } }).catch(() => undefined);
    await prisma.encounter.deleteMany({ where: { id: { in: encIds } } }).catch(() => undefined);
    await prisma.opSession.deleteMany({ where: { doctorId: DOCTOR } }).catch(() => undefined);
    await prisma.tokenSeries.deleteMany({ where: { id: SERIES } }).catch(() => undefined);
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR } });
    await prisma.payment.deleteMany({ where: { booking: { is: null } } }).catch(() => undefined);
    await prisma.patient.deleteMany({ where: { mobile: { in: [PHONE, FILLER_PHONE] } } });
    await prisma.doctorSession.deleteMany({ where: { doctorId: DOCTOR } });
    await prisma.doctor.deleteMany({ where: { id: DOCTOR } });
    await prisma.voiceNumber.deleteMany({ where: { clinicId: CLINIC } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC } });
    await prisma.hospital.deleteMany({ where: { id: HOSP } });
  }

  /**
   * Resolve the OP encounter the mirror created for a legacy booking. The mirror
   * records the correlation in `Registration.channelMeta.legacyBookingId` (the
   * `Encounter.legacyBookingId` COLUMN is only populated by the backfill script),
   * so this is the supported lookup for mirrored rows.
   */
  const encounterForBooking = async (bookingId: string) => {
    const reg = await prisma.registration.findFirstOrThrow({
      where: { source: 'VOICE_AGENT', channelMeta: { path: ['legacyBookingId'], equals: bookingId } },
      select: { encounterId: true },
    });
    return prisma.encounter.findUniqueOrThrow({ where: { id: reg.encounterId } });
  };

  const voice = (path: string, body: unknown, secret: string | null = SECRET) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret ? { 'x-voice-secret': secret } : {}),
      },
      body: JSON.stringify(body),
    });

  it('rejects without / with a wrong voice secret (401)', async () => {
    expect((await voice('/voice/availability', { didNumber: DID }, null)).status).toBe(401);
    expect((await voice('/voice/availability', { didNumber: DID }, 'wrong')).status).toBe(401);
  });

  it('availability resolves the DID to the clinic and lists same-day doctors', async () => {
    const res = await voice('/voice/availability', { didNumber: DID, specialty: 'cardio' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      clinicId: string; clinicName: string;
      doctors: Array<{ doctorId: string; consultationFee: number; sessions: Array<{ sessionType: string; waiting: number; etaMinutes: number }> }>;
    };
    expect(body.clinicId).toBe(CLINIC);
    const doc = body.doctors.find((d) => d.doctorId === DOCTOR);
    expect(doc).toBeDefined();
    expect(doc!.consultationFee).toBe(400);
    expect(doc!.sessions[0].sessionType).toBe('MORNING');
    expect(doc!.sessions[0].waiting).toBe(1); // the pre-filled walk-in
  });

  it('unknown DID -> 404', async () => {
    expect((await voice('/voice/availability', { didNumber: '+919999999999' }, SECRET)).status).toBe(404);
  });

  it('book issues a pay-at-desk OP token; idempotent on callSid', async () => {
    const res = await voice('/voice/bookings', {
      didNumber: DID, doctorId: DOCTOR, sessionType: 'MORNING',
      patientPhone: PHONE, patientName: 'Voice Caller', callSid: 'call-1',
    });
    expect(res.status).toBe(201);
    const b = (await res.json()) as { bookingId: string; tokenNumber: string; status: string; sessionDate: string };
    // OP series (prefix N, padWidth 3) is authoritative — NOT a legacy queue token.
    expect(b.tokenNumber).toMatch(/^N\d{3}$/);
    opToken = b.tokenNumber;
    expect(b.status).toBe('BOOKED');
    expect(b.sessionDate).toBe(session.sessionDate);

    const row = await prisma.booking.findUniqueOrThrow({
      where: { id: b.bookingId },
      select: { source: true, payAtDesk: true, voiceCallSid: true, tokenNumber: true, payment: { select: { status: true, amount: true } } },
    });
    expect(row.source).toBe('VOICE');
    expect(row.payAtDesk).toBe(true);
    expect(row.voiceCallSid).toBe('call-1');
    expect(row.tokenNumber).toBe(opToken); // OP token copied onto the legacy anchor
    expect(row.payment?.status).toBe(PaymentStatus.CREATED); // unpaid, due at desk
    expect(row.payment?.amount).toBe(40000); // ₹400 in paise

    // The caller is checked in and queued in the OP engine, ready on the
    // doctor/reception frontends without anyone touching the desk.
    const enc = await encounterForBooking(b.bookingId);
    expect(enc.status).toBe(EncounterStatus.WAITING);
    const token = await prisma.token.findUnique({ where: { encounterId: enc.id } });
    expect(token?.displayNumber).toBe(opToken);

    // The legacy Redis queue is NOT used by voice any more — only the filler.
    expect(await queue.size(session)).toBe(1);

    // Retry with the SAME callSid -> same booking, no second token.
    const again = await voice('/voice/bookings', {
      didNumber: DID, doctorId: DOCTOR, sessionType: 'MORNING', patientPhone: PHONE, callSid: 'call-1',
    });
    const b2 = (await again.json()) as { bookingId: string; tokenNumber: string };
    expect(b2.bookingId).toBe(b.bookingId);
    expect(b2.tokenNumber).toBe(opToken);
    // still exactly one OP encounter for this caller
    expect(
      await prisma.registration.count({
        where: { source: 'VOICE_AGENT', channelMeta: { path: ['legacyBookingId'], equals: b.bookingId } },
      }),
    ).toBe(1);
  });

  it('rejects a session the caller asked for that is not the one open now (409)', async () => {
    const res = await voice('/voice/bookings', {
      didNumber: DID, doctorId: DOCTOR, sessionType: 'EVENING', // doctor only sits MORNING
      patientPhone: PHONE, callSid: 'call-mismatch',
    });
    expect(res.status).toBe(409);
  });

  it('a repeat call for a doctor already held returns the same token (no phantom hold)', async () => {
    const before = await queue.size(session);
    const res = await voice('/voice/bookings', {
      didNumber: DID, doctorId: DOCTOR, sessionType: 'MORNING',
      patientPhone: PHONE, callSid: 'call-different', // different call, same caller+doctor
    });
    expect(res.status).toBe(201);
    const b = (await res.json()) as { tokenNumber: string };
    expect(b.tokenNumber).toBe(opToken); // the existing hold, not a new token
    expect(await queue.size(session)).toBe(before); // queue unchanged
    // and crucially no second OP token minted for the same caller+session
    const encs = await prisma.encounter.findMany({ where: { doctorId: DOCTOR }, select: { id: true } });
    expect(
      await prisma.token.count({ where: { encounterId: { in: encs.map((e) => e.id) } } }),
    ).toBe(1);
  });

  it('lookup returns the caller’s live appointment, scoped to the dialed clinic', async () => {
    const res = await voice('/voice/appointments/lookup', { didNumber: DID, patientPhone: PHONE });
    expect(res.status).toBe(201);
    const rows = (await res.json()) as Array<{ appointmentId: string; doctorId: string; tokenNumber: string; status: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].doctorId).toBe(DOCTOR);
    expect(rows[0].tokenNumber).toBe(opToken);
  });

  it('reception collects the pay-at-desk payment -> Payment SUCCESS, roster shows paid', async () => {
    const lookup = (await (await voice('/voice/appointments/lookup', { didNumber: DID, patientPhone: PHONE })).json()) as Array<{ appointmentId: string }>;
    const bookingId = lookup[0].appointmentId;

    const res = await fetch(`${url}/reception/bookings/${bookingId}/collect-payment`, {
      method: 'POST',
      headers: { authorization: `Bearer ${staffToken}` },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { paid: boolean; amountPaise: number };
    expect(body.paid).toBe(true);
    expect(body.amountPaise).toBe(40000);

    const pay = await prisma.payment.findFirstOrThrow({ where: { bookingId } });
    expect(pay.status).toBe(PaymentStatus.SUCCESS);
  });

  it('cancel cancels the booking and records a VOICE-channel audit entry', async () => {
    const lookup = (await (await voice('/voice/appointments/lookup', { didNumber: DID, patientPhone: PHONE })).json()) as Array<{ appointmentId: string }>;
    const bookingId = lookup[0].appointmentId;

    const res = await voice('/voice/appointments/cancel', {
      didNumber: DID,
      patientPhone: PHONE,
      appointmentId: bookingId,
    });
    expect(res.status).toBe(201);
    const rec = (await res.json()) as { status: string };
    expect(rec.status).toBe('CANCELLED');

    const row = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(row.status).toBe(BookingStatus.CANCELLED);

    const audit = await prisma.auditLog.findFirst({ where: { bookingId, action: 'CANCEL' } });
    expect(audit).not.toBeNull();
    expect((audit!.metadata as { channel?: string }).channel).toBe('VOICE');

    // The OP side must drop too, or a phone-cancelled token keeps showing on the
    // doctor/reception frontends (the token lives in OP, not the legacy queue).
    const enc = await encounterForBooking(bookingId);
    expect(enc.status).toBe(EncounterStatus.CANCELLED);

    // ...and it is pulled from the live OP line, so it stops being callable.
    // NOTE: the `QueueEntry` ROW deliberately survives — Redis is the ordering
    // authority and `QueueEntry.state` is never updated by ANY exit path
    // (cancel/skip/no-show/complete all leave it WAITING). Asserting on the row
    // would assert nothing.
    const entry = await prisma.queueEntry.findUniqueOrThrow({ where: { encounterId: enc.id } });
    const waiting = await opQueue.listWaiting(entry.opSessionId);
    expect(waiting.map((w) => w.encounterId)).not.toContain(enc.id);

    // legacy queue never held the voice token — the filler walk-in is untouched
    expect(await queue.size(session)).toBe(1);
  });

  /**
   * The voice secret proves the request came from the agent process, not that
   * the caller is entitled to the booking. Before this was enforced, a bare
   * appointmentId cancelled ANY booking at ANY clinic — including refunding it.
   * Both halves of the scope are pinned here: the dialed clinic, and the
   * calling number. A booking outside either must read as not-found, so the
   * response cannot be used to probe which ids exist.
   */
  it('cancel refuses a booking outside the dialed clinic / calling number', async () => {
    // Books its own target rather than reusing one: the cancel test above
    // leaves no BOOKED row behind, and this test must end with the booking
    // still BOOKED to prove nothing was cancelled.
    const created = await voice('/voice/bookings', {
      didNumber: DID, doctorId: DOCTOR, sessionType: 'MORNING',
      patientPhone: PHONE, patientName: 'Voice Caller', callSid: 'call-scope',
    });
    expect(created.status).toBe(201);
    const booking = (await created.json()) as { bookingId: string };

    // right clinic, wrong caller
    const wrongCaller = await voice('/voice/appointments/cancel', {
      didNumber: DID,
      patientPhone: '9399999999',
      appointmentId: booking.bookingId,
    });
    expect(wrongCaller.status).toBe(404);

    // right caller, a DID that is not this booking's clinic
    const otherDid = await voice('/voice/appointments/cancel', {
      didNumber: '+919999999999',
      patientPhone: PHONE,
      appointmentId: booking.bookingId,
    });
    expect(otherDid.status).toBe(404);

    // scope is mandatory: an id on its own is rejected outright
    const noScope = await voice('/voice/appointments/cancel', { appointmentId: booking.bookingId });
    expect(noScope.status).toBe(400);

    // and the booking is untouched by any of the three
    const row = await prisma.booking.findUniqueOrThrow({ where: { id: booking.bookingId } });
    expect(row.status).toBe(BookingStatus.BOOKED);
  });

  /**
   * One phone, two people. Identity here is the MOBILE, and a shared household
   * phone is normal — so a later caller stating a different name must not rename
   * the patient whose token is already issued and already on the reception
   * roster. A live call did exactly that: token N001 was booked for one name and
   * then displayed under another.
   */
  it('a later stated name does not overwrite the patient it belongs to', async () => {
    const phone = '9300009003';
    const first = await voice('/voice/bookings', {
      didNumber: DID,
      doctorId: DOCTOR,
      sessionType: 'MORNING',
      patientPhone: phone,
      patientName: 'First Caller',
      callSid: 'call-name-1',
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { tokenNumber: string };

    const patientAfterFirst = await prisma.patient.findUniqueOrThrow({
      where: { mobile: phone },
      select: { id: true, name: true },
    });
    expect(patientAfterFirst.name).toBe('First Caller');

    // Same phone, same doctor, same day, DIFFERENT stated name. Dedup returns the
    // held booking — and the name on record must be untouched.
    const second = await voice('/voice/bookings', {
      didNumber: DID,
      doctorId: DOCTOR,
      sessionType: 'MORNING',
      patientPhone: phone,
      patientName: 'Second Caller',
      callSid: 'call-name-2',
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { bookingId: string; tokenNumber: string };

    const patientAfterSecond = await prisma.patient.findUniqueOrThrow({
      where: { mobile: phone },
      select: { name: true },
    });
    expect(patientAfterSecond.name).toBe('First Caller');

    // The name stated on the booking call is still recorded — on the
    // registration, which is where a per-booking name belongs.
    const encounter = await prisma.encounter.findFirst({
      where: { patientId: patientAfterFirst.id },
      select: { id: true },
    });
    expect(encounter).not.toBeNull();
    const registration = await prisma.registration.findFirstOrThrow({
      where: { encounterId: encounter!.id },
      select: { channelMeta: true },
    });
    expect((registration.channelMeta as { bookedName?: string }).bookedName).toBe('First Caller');
    // Dedup: the same held token, not a second one.
    expect(secondBody.tokenNumber).toBe(firstBody.tokenNumber);
  });

  it('call-logs persists idempotently by callSid', async () => {
    const r1 = await voice('/voice/call-logs', { callSid: 'log-1', didNumber: DID, callerPhone: PHONE, outcome: 'booked', duration: 42 });
    expect(r1.status).toBe(201);
    const r2 = await voice('/voice/call-logs', { callSid: 'log-1', didNumber: DID, callerPhone: PHONE, outcome: 'cancelled', duration: 50 });
    expect(r2.status).toBe(201);

    const logs = await prisma.voiceCallLog.findMany({ where: { callSid: 'log-1' } });
    expect(logs.length).toBe(1); // upserted, not duplicated
    expect(logs[0].outcome).toBe('cancelled'); // last write wins
    expect(logs[0].clinicId).toBe(CLINIC); // DID resolved
  });
});
