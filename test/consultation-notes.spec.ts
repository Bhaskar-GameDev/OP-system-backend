import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthTokenService } from '../src/auth/auth-token.service';

/**
 * Consultation notes — closing the doctor↔patient loop.
 *
 * Covers: doctor upsert (create then edit), optional-everything saves, patient
 * read scoping (own booking only, null when no note), doctor cross-scope 403,
 * and the today's-completed listing with hasNote.
 */
describe('Consultation notes', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let tokens: AuthTokenService;

  const CLINIC = 'note-clinic';
  const DOC = 'note-doc';
  const DOC_OTHER = 'note-doc-other';
  const PT = 'note-pt';
  const PT_OTHER = 'note-pt-other';
  const BK = 'note-bk'; // completed booking, today, DOC + PT
  let docToken = '';
  let docOtherToken = '';
  let ptToken = '';
  let ptOtherToken = '';

  function today(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    tokens = app.get(AuthTokenService);

    await cleanup();
    await prisma.clinic.create({ data: { id: CLINIC, name: 'Note Clinic' } });
    await prisma.doctor.createMany({
      data: [
        { id: DOC, clinicId: CLINIC, name: 'Dr Note' },
        { id: DOC_OTHER, clinicId: CLINIC, name: 'Dr Other' },
      ],
    });
    await prisma.patient.createMany({
      data: [
        { id: PT, name: 'Note Patient', mobile: '9100000201' },
        { id: PT_OTHER, name: 'Other Patient', mobile: '9100000202' },
      ],
    });
    await prisma.booking.create({
      data: {
        id: BK,
        patientId: PT,
        doctorId: DOC,
        source: 'APP',
        tokenNumber: 'A001',
        sessionDate: today(),
        sessionType: 'MORNING',
        status: 'COMPLETED',
        consultationEndedAt: new Date(),
      },
    });

    docToken = tokens.sign({ sub: DOC, role: 'DOCTOR', doctorId: DOC });
    docOtherToken = tokens.sign({ sub: DOC_OTHER, role: 'DOCTOR', doctorId: DOC_OTHER });
    ptToken = tokens.sign({ sub: PT, role: 'PATIENT' });
    ptOtherToken = tokens.sign({ sub: PT_OTHER, role: 'PATIENT' });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await prisma.consultationNote.deleteMany({ where: { doctorId: { in: [DOC, DOC_OTHER] } } });
    await prisma.booking.deleteMany({ where: { doctorId: { in: [DOC, DOC_OTHER] } } });
    await prisma.doctor.deleteMany({ where: { clinicId: CLINIC } });
    await prisma.patient.deleteMany({ where: { id: { in: [PT, PT_OTHER] } } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC } });
  }

  function api(path: string, init: RequestInit, token: string) {
    return fetch(`${url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  }

  it('patient sees null before any note is recorded', async () => {
    const res = await api(`/me/bookings/${BK}/note`, {}, ptToken);
    expect(res.status).toBe(200);
    // null -> Nest sends an empty body; the app client maps "" to undefined/null
    const text = await res.text();
    expect(text === '' || JSON.parse(text) === null).toBe(true);
  });

  it('doctor saves a note, then edits it (upsert)', async () => {
    const create = await api(
      '/doctor/notes',
      {
        method: 'POST',
        body: JSON.stringify({
          bookingId: BK,
          notes: 'Mild fever',
          diagnosis: 'Viral',
          prescriptions: 'Paracetamol 500mg',
          followUpDate: '2026-07-01',
        }),
      },
      docToken,
    );
    expect(create.status).toBe(201);
    const created = await create.json();
    expect(created.notes).toBe('Mild fever');
    expect(created.followUpDate).toBe('2026-07-01');

    const edit = await api(
      '/doctor/notes',
      { method: 'POST', body: JSON.stringify({ bookingId: BK, notes: 'Mild fever, improving' }) },
      docToken,
    );
    const edited = await edit.json();
    expect(edited.notes).toBe('Mild fever, improving');
    expect(edited.diagnosis).toBeNull(); // cleared on this save

    // exactly one row (upsert, not insert)
    const count = await prisma.consultationNote.count({ where: { bookingId: BK } });
    expect(count).toBe(1);
  });

  it('an empty save still works (notes optional, doctor never blocked)', async () => {
    const res = await api('/doctor/notes', { method: 'POST', body: JSON.stringify({ bookingId: BK }) }, docToken);
    expect(res.status).toBe(201);
    expect((await res.json()).notes).toBe('');
  });

  it('patient reads their own note; another patient is 404', async () => {
    const mine = await api(`/me/bookings/${BK}/note`, {}, ptToken);
    expect((await mine.json()).bookingId).toBe(BK);

    const other = await api(`/me/bookings/${BK}/note`, {}, ptOtherToken);
    expect(other.status).toBe(404);
  });

  it("a different doctor cannot write the booking's note", async () => {
    const res = await api('/doctor/notes', { method: 'POST', body: JSON.stringify({ bookingId: BK, notes: 'hi' }) }, docOtherToken);
    expect(res.status).toBe(403);
  });

  it("today's completed list flags hasNote", async () => {
    const res = await api('/doctor/completed?sessionType=MORNING', {}, docToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    const entry = body.entries.find((e: { bookingId: string }) => e.bookingId === BK);
    expect(entry).toBeTruthy();
    expect(entry.hasNote).toBe(true);
    expect(entry.patientName).toBe('Note Patient');
  });
});
