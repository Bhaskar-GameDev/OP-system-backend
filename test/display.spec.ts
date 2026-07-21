import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { AddressInfo } from 'node:net';
import { io, Socket } from 'socket.io-client';
import { BookingSource, BookingStatus, SessionType } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthTokenService } from '../src/auth/auth-token.service';
import { ConsultationService } from '../src/queue-engine/consultation.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { SessionKey, TokenSource } from '../src/queue-engine/token.service';
import { DisplayBoard } from '../src/display/display.service';

/**
 * Waiting-room display board — the public, unauthenticated surface.
 *
 * Two clinics sit inside the SAME hospital, which is the boundary most at risk:
 * a shared tenant means no hospital-level filter can accidentally save us, so
 * clinic scoping has to hold on its own. Proven against real Postgres + Redis +
 * Socket.io, over both the REST state endpoint and the live display room.
 */
describe('Waiting-room display (real infra)', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let queue: QueueService;
  let consult: ConsultationService;
  let tokens: AuthTokenService;

  const HOSP = 'disp-hosp';
  const CLINIC_A = 'disp-clinic-a';
  const CLINIC_B = 'disp-clinic-b';
  const DOC_A = 'disp-doc-a';
  const DOC_A2 = 'disp-doc-a2'; // second doctor at clinic A, left idle
  const DOC_B = 'disp-doc-b';
  const PT_A = 'disp-pt-a';
  const PT_B = 'disp-pt-b';

  /** Distinctive enough that a substring search over the payload is meaningful. */
  const PATIENT_A_NAME = 'Zeenat Qureshi ZZQQ';
  const PATIENT_A_MOBILE = '9411000001';

  // The board is always "today" — it reads the server clock, so the fixtures
  // must be scheduled for whatever day the suite happens to run.
  const now = new Date();
  const DATE = ymdLocal(now);
  const DOW = now.getDay();

  const sessionA: SessionKey = {
    doctorId: DOC_A,
    sessionDate: DATE,
    sessionType: 'MORNING',
  };
  const sessionA2: SessionKey = {
    doctorId: DOC_A2,
    sessionDate: DATE,
    sessionType: 'MORNING',
  };
  const sessionB: SessionKey = {
    doctorId: DOC_B,
    sessionDate: DATE,
    sessionType: 'MORNING',
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useWebSocketAdapter(new IoAdapter(app));
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    queue = app.get(QueueService);
    consult = app.get(ConsultationService);
    tokens = app.get(AuthTokenService);

    await cleanup();

    await prisma.hospital.create({ data: { id: HOSP, name: 'Display Hospital' } });
    await prisma.clinic.createMany({
      data: [
        { id: CLINIC_A, hospitalId: HOSP, name: 'Ashwini Clinic' },
        { id: CLINIC_B, hospitalId: HOSP, name: 'Bharat Clinic' },
      ],
    });
    await prisma.doctor.createMany({
      data: [
        {
          id: DOC_A,
          clinicId: CLINIC_A,
          name: 'Dr Anand Rao',
          specialization: 'Cardiology',
          avgConsultMinutes: 6,
        },
        {
          id: DOC_A2,
          clinicId: CLINIC_A,
          name: 'Dr Bhavna Iyer',
          specialization: 'Dermatology',
          avgConsultMinutes: 8,
        },
        {
          id: DOC_B,
          clinicId: CLINIC_B,
          name: 'Dr Chandra Menon',
          specialization: 'Orthopaedics',
          avgConsultMinutes: 5,
        },
      ],
    });

    // A morning session on today's weekday with no evening counterpart is open
    // until end-of-day, so the board shows these doctors whenever the suite runs.
    await prisma.doctorSession.createMany({
      data: [DOC_A, DOC_A2, DOC_B].map((doctorId) => ({
        doctorId,
        sessionType: SessionType.MORNING,
        startTime: '00:01',
        maxTokens: 50,
        daysOfWeek: [DOW],
      })),
    });

    await prisma.patient.createMany({
      data: [
        { id: PT_A, name: PATIENT_A_NAME, mobile: PATIENT_A_MOBILE },
        { id: PT_B, name: 'Patient B', mobile: '9411000002' },
      ],
    });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    for (const s of [sessionA, sessionA2, sessionB]) {
      await queue.clearSession(s);
    }
    await prisma.booking.deleteMany({
      where: { doctorId: { in: [DOC_A, DOC_A2, DOC_B] } },
    });
    await prisma.doctorSession.deleteMany({
      where: { doctorId: { in: [DOC_A, DOC_A2, DOC_B] } },
    });
    await prisma.doctor.deleteMany({ where: { id: { in: [DOC_A, DOC_A2, DOC_B] } } });
    await prisma.patient.deleteMany({ where: { id: { in: [PT_A, PT_B] } } });
    await prisma.clinic.deleteMany({ where: { id: { in: [CLINIC_A, CLINIC_B] } } });
    await prisma.hospital.deleteMany({ where: { id: HOSP } });
  }

  /** Create a paid booking and put it in the live queue, as the real flow does. */
  async function book(
    patientId: string,
    session: SessionKey,
  ): Promise<{ bookingId: string; token: string }> {
    const booking = await prisma.booking.create({
      data: {
        patientId,
        doctorId: session.doctorId,
        source: BookingSource.APP,
        sessionDate: new Date(`${session.sessionDate}T00:00:00.000Z`),
        sessionType: session.sessionType as SessionType,
        status: BookingStatus.BOOKED,
      },
      select: { id: true },
    });
    const entry = await consult.enqueueBooking(TokenSource.APP, session, booking.id);
    await prisma.booking.update({
      where: { id: booking.id },
      data: { tokenNumber: entry.tokenNumber },
    });
    return { bookingId: booking.id, token: entry.tokenNumber };
  }

  const state = async (clinicId: string): Promise<Response> =>
    fetch(`${url}/display/${clinicId}/state`);

  // ── clinic scoping ─────────────────────────────────────────
  describe('tenant scoping', () => {
    beforeAll(async () => {
      // Clinic A: three in the queue (one served + two waiting).
      await book(PT_A, sessionA);
      await book(PT_A, sessionA);
      await book(PT_A, sessionA);
      // Clinic B: its own, separately-numbered queue.
      await book(PT_B, sessionB);
      await book(PT_B, sessionB);
      // DOC_A2 is deliberately left with no bookings — the idle case.
    });

    it('serves only the requested clinic’s doctors', async () => {
      const res = await state(CLINIC_A);
      expect(res.status).toBe(200);
      const board = (await res.json()) as DisplayBoard;

      expect(board.clinicId).toBe(CLINIC_A);
      expect(board.clinicName).toBe('Ashwini Clinic');
      expect(board.date).toBe(DATE);

      const ids = board.doctors.map((d) => d.doctorId).sort();
      expect(ids).toEqual([DOC_A, DOC_A2].sort());
      expect(ids).not.toContain(DOC_B);
    });

    it('does not leak the other clinic’s queue into the payload', async () => {
      const res = await state(CLINIC_A);
      const raw = await res.text();

      // Nothing identifying clinic B — not its id, name, or doctor.
      expect(raw).not.toContain(CLINIC_B);
      expect(raw).not.toContain('Bharat Clinic');
      expect(raw).not.toContain(DOC_B);
      expect(raw).not.toContain('Dr Chandra Menon');
    });

    it('each clinic reports its own independent queue', async () => {
      const [a, b] = await Promise.all([
        state(CLINIC_A).then((r) => r.json() as Promise<DisplayBoard>),
        state(CLINIC_B).then((r) => r.json() as Promise<DisplayBoard>),
      ]);

      const docA = a.doctors.find((d) => d.doctorId === DOC_A);
      const docB = b.doctors.find((d) => d.doctorId === DOC_B);

      expect(docA?.waitingCount).toBe(2); // 3 queued, 1 being served
      expect(docB?.waitingCount).toBe(1); // 2 queued, 1 being served
      expect(b.doctors.map((d) => d.doctorId)).toEqual([DOC_B]);
    });

    it('404s an unknown clinic instead of serving a blank board', async () => {
      const res = await state('disp-clinic-does-not-exist');
      expect(res.status).toBe(404);
    });

    it('404s the page route for an unknown clinic', async () => {
      const res = await fetch(`${url}/display/disp-clinic-does-not-exist`);
      expect(res.status).toBe(404);
    });
  });

  // ── privacy ────────────────────────────────────────────────
  describe('privacy', () => {
    it('exposes no patient identity anywhere in the payload', async () => {
      const raw = await state(CLINIC_A).then((r) => r.text());

      expect(raw).not.toContain(PATIENT_A_NAME);
      expect(raw).not.toContain(PATIENT_A_MOBILE);
      expect(raw).not.toContain(PT_A);
      // Booking ids would let a scraper correlate a token back to a person.
      const bookings = await prisma.booking.findMany({
        where: { doctorId: DOC_A },
        select: { id: true },
      });
      for (const b of bookings) expect(raw).not.toContain(b.id);
    });

    it('carries only the documented card fields', async () => {
      const board = (await state(CLINIC_A).then((r) => r.json())) as DisplayBoard;
      for (const card of board.doctors) {
        expect(Object.keys(card).sort()).toEqual(
          [
            'doctorId',
            'name',
            'nextEtaMinutes',
            'nowServing',
            'recentTokens',
            'sessionType',
            'specialization',
            'waitingCount',
          ].sort(),
        );
      }
    });
  });

  // ── card content ───────────────────────────────────────────
  describe('card content', () => {
    it('shows the token being served and an ETA once the queue is worth one', async () => {
      const board = (await state(CLINIC_A).then((r) => r.json())) as DisplayBoard;
      const card = board.doctors.find((d) => d.doctorId === DOC_A);

      expect(card?.nowServing).toBe('A001');
      expect(card?.name).toBe('Dr Anand Rao');
      expect(card?.specialization).toBe('Cardiology');
      expect(card?.nextEtaMinutes).toBe(12); // 2 waiting x 6 min
    });

    it('keeps an idle doctor on the board rather than hiding them', async () => {
      const board = (await state(CLINIC_A).then((r) => r.json())) as DisplayBoard;
      const card = board.doctors.find((d) => d.doctorId === DOC_A2);

      expect(card).toBeDefined();
      expect(card?.nowServing).toBeNull();
      expect(card?.waitingCount).toBe(0);
      expect(card?.recentTokens).toEqual([]);
      // A two-person queue is too small for an ETA to mean anything.
      expect(card?.nextEtaMinutes).toBeNull();
    });

    it('lists recently completed tokens, newest first', async () => {
      await consult.markDone(sessionA, 'A001');
      await consult.markDone(sessionA, 'A002');

      const board = (await state(CLINIC_A).then((r) => r.json())) as DisplayBoard;
      const card = board.doctors.find((d) => d.doctorId === DOC_A);

      expect(card?.recentTokens).toEqual(['A002', 'A001']);
      expect(card?.nowServing).toBe('A003');
      expect(card?.waitingCount).toBe(0);
    });
  });

  // ── the page itself ────────────────────────────────────────
  describe('page route', () => {
    it('serves the board page with no authentication', async () => {
      const res = await fetch(`${url}/display/${CLINIC_A}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');

      const html = await res.text();
      expect(html).toContain('<title>Queue Board</title>');
      expect(html).toContain('/socket.io/socket.io.js');
    });
  });

  // ── live feed ──────────────────────────────────────────────
  describe('live display room', () => {
    const sockets: Socket[] = [];

    const connectDisplay = (clinicId: string): Socket => {
      const s = io(url, {
        query: { display: 'true', clinicId },
        transports: ['websocket'],
        forceNew: true,
      });
      sockets.push(s);
      return s;
    };

    afterAll(() => {
      for (const s of sockets) s.disconnect();
    });

    it('connects with no token and receives an opening snapshot', async () => {
      const s = connectDisplay(CLINIC_A);
      const board = await once<DisplayBoard>(s, 'display:snapshot');

      expect(board.clinicId).toBe(CLINIC_A);
      expect(board.doctors.map((d) => d.doctorId).sort()).toEqual(
        [DOC_A, DOC_A2].sort(),
      );
    });

    it('pushes a sanitized card when the queue advances', async () => {
      const s = connectDisplay(CLINIC_A);
      await once(s, 'display:snapshot');

      const before = await book(PT_A, sessionA); // A004 joins behind A003
      const update = await once<{ clinicId: string; doctor: Record<string, unknown> }>(
        s,
        'display:update',
      );

      expect(update.clinicId).toBe(CLINIC_A);
      expect(update.doctor.doctorId).toBe(DOC_A);
      expect(update.doctor.waitingCount).toBe(1);
      expect(JSON.stringify(update.doctor)).not.toContain(PATIENT_A_NAME);
      expect(JSON.stringify(update.doctor)).not.toContain(before.bookingId);
    });

    it('reflects a newly called token within a second', async () => {
      const s = connectDisplay(CLINIC_A);
      await once(s, 'display:snapshot');

      const advanced = new Promise<{ doctor: { nowServing: string } }>((resolve) => {
        s.on('display:update', (msg: { doctor: { nowServing: string } }) => {
          if (msg.doctor.nowServing === 'A004') resolve(msg);
        });
      });

      await consult.markDone(sessionA, 'A003');
      const msg = await withTimeout(advanced, 1000, 'no display:update for A004');
      expect(msg.doctor.nowServing).toBe('A004');
    });

    it('never delivers another clinic’s events', async () => {
      const s = connectDisplay(CLINIC_A);
      await once(s, 'display:snapshot');

      const seen: string[] = [];
      s.on('display:update', (m: { doctor: { doctorId: string } }) =>
        seen.push(m.doctor.doctorId),
      );

      await book(PT_B, sessionB); // clinic B moves
      await new Promise((r) => setTimeout(r, 400));

      expect(seen).not.toContain(DOC_B);
    });

    it('rejects an unknown clinic instead of parking the socket', async () => {
      const s = connectDisplay('disp-clinic-does-not-exist');
      const err = await once<{ message: string }>(s, 'error');
      expect(err.message).toBe('unknown clinic');
    });

    it('cannot join a staff session room', async () => {
      const s = connectDisplay(CLINIC_A);
      await once(s, 'display:snapshot');

      const leaked: unknown[] = [];
      s.on('queue:update', (m: unknown) => leaked.push(m));

      const err = new Promise<{ message: string }>((resolve) =>
        s.on('error', resolve),
      );
      s.emit('join', {
        doctorId: DOC_A,
        sessionDate: DATE,
        sessionType: 'MORNING',
      });
      expect((await withTimeout(err, 2000, 'no rejection')).message).toBe('forbidden');

      // and the room it tried to enter still sends it nothing
      await consult.markDone(sessionA, 'A004');
      await new Promise((r) => setTimeout(r, 400));
      expect(leaked).toEqual([]);
    });

    it('still requires a token for non-display sockets', async () => {
      const s = io(url, { transports: ['websocket'], forceNew: true });
      sockets.push(s);
      const err = await once<{ message: string }>(s, 'error');
      expect(err.message).toBe('unauthorized');
    });

    it('does not let a valid staff token reach the display path without opting in', async () => {
      // Guards the handshake parser: a stray clinicId must not silently demote
      // an authenticated socket onto the unauthenticated branch.
      const staff = tokens.sign({
        sub: 'disp-staff',
        role: 'STAFF',
        clinicId: CLINIC_A,
        hospitalId: HOSP,
      });
      const s = io(url, {
        auth: { token: staff },
        query: { clinicId: CLINIC_A },
        transports: ['websocket'],
        forceNew: true,
      });
      sockets.push(s);

      await once(s, 'connect');
      s.emit('join', {
        doctorId: DOC_A,
        sessionDate: DATE,
        sessionType: 'MORNING',
      });
      // Reaching the staff snapshot proves it stayed on the authenticated path.
      const snap = await once<{ kind: string }>(s, 'snapshot');
      expect(snap.kind).toBe('session');
    });
  });
});

/** Resolve on the next occurrence of `event`, or reject after a timeout. */
function once<T>(socket: Socket, event: string, ms = 5000): Promise<T> {
  return withTimeout(
    new Promise<T>((resolve) => socket.once(event, resolve)),
    ms,
    `timed out waiting for "${event}"`,
  );
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
