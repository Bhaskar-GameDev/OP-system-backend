import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { BookingSource, BookingStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthTokenService } from '../src/auth/auth-token.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { SessionKey, TokenSource } from '../src/queue-engine/token.service';

/**
 * GET /doctor/queue — the doctor's OWN live session for today, enriched with
 * patient name / source / status. Proves: scope comes from the JWT doctorId
 * (not a param), the queue order + names are returned, and the role guard
 * rejects non-doctors.
 */
describe('Doctor queue (full stack)', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let tokens: AuthTokenService;
  let queue: QueueService;

  const CLINIC = 'dq-clinic';
  const DOCTOR = 'dq-doctor';
  const today = todayLocal();
  const session: SessionKey = { doctorId: DOCTOR, sessionDate: today, sessionType: 'MORNING' };

  let doctorToken = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    prisma = app.get(PrismaService);
    tokens = app.get(AuthTokenService);
    queue = app.get(QueueService);

    await cleanup();
    await prisma.clinic.create({ data: { id: CLINIC, name: 'DQ Clinic' } });
    await prisma.doctor.create({ data: { id: DOCTOR, clinicId: CLINIC, name: 'Dr Queue' } });

    // two BOOKED patients enqueued for today's morning session
    await enqueuePatient('dq-pt-1', 'Asha Rao');
    await enqueuePatient('dq-pt-2', 'Bilal Khan');

    doctorToken = tokens.sign({ sub: DOCTOR, role: 'DOCTOR', doctorId: DOCTOR, clinicId: CLINIC });
  });

  afterAll(async () => {
    await queue.clearSession(session);
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await queue.clearSession(session);
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR } });
    await prisma.patient.deleteMany({ where: { id: { startsWith: 'dq-pt-' } } });
    await prisma.doctor.deleteMany({ where: { id: DOCTOR } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC } });
  }

  async function enqueuePatient(id: string, name: string): Promise<string> {
    await prisma.patient.create({ data: { id, name, mobile: `9${Date.now()}${id.slice(-1)}` } });
    const booking = await prisma.booking.create({
      data: {
        patientId: id,
        doctorId: DOCTOR,
        source: BookingSource.APP,
        sessionDate: new Date(today),
        sessionType: 'MORNING',
        status: BookingStatus.BOOKED,
      },
    });
    const entry = await queue.enqueue(TokenSource.APP, session, booking.id);
    await prisma.booking.update({ where: { id: booking.id }, data: { tokenNumber: entry.tokenNumber } });
    return entry.tokenNumber;
  }

  it('returns the doctor own queue with patient names, front-to-back', async () => {
    const res = await fetch(`${url}/doctor/queue?sessionType=MORNING`, {
      headers: { authorization: `Bearer ${doctorToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      doctorId: string;
      sessionDate: string;
      total: number;
      activeToken: string | null;
      entries: Array<{ tokenNumber: string; patientName: string | null; status: string }>;
    };
    expect(body.doctorId).toBe(DOCTOR);
    expect(body.sessionDate).toBe(today);
    expect(body.total).toBe(2);
    expect(body.activeToken).toBe(body.entries[0].tokenNumber);
    expect(body.entries.map((e) => e.patientName)).toEqual(['Asha Rao', 'Bilal Khan']);
  });

  it('rejects a bad sessionType with 400', async () => {
    const res = await fetch(`${url}/doctor/queue?sessionType=NOON`, {
      headers: { authorization: `Bearer ${doctorToken}` },
    });
    expect(res.status).toBe(400);
  });

  it('role guard: no token -> 401, patient -> 403, staff -> 403', async () => {
    const noAuth = await fetch(`${url}/doctor/queue?sessionType=MORNING`);
    expect(noAuth.status).toBe(401);

    const patient = tokens.sign({ sub: 'dq-pt-1', role: 'PATIENT' });
    const asPatient = await fetch(`${url}/doctor/queue?sessionType=MORNING`, {
      headers: { authorization: `Bearer ${patient}` },
    });
    expect(asPatient.status).toBe(403);

    const staff = tokens.sign({ sub: 'dq-staff', role: 'STAFF', clinicId: CLINIC });
    const asStaff = await fetch(`${url}/doctor/queue?sessionType=MORNING`, {
      headers: { authorization: `Bearer ${staff}` },
    });
    expect(asStaff.status).toBe(403);
  });
});

/** Local YYYY-MM-DD — matches DoctorService.today() (server-local calendar). */
function todayLocal(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
