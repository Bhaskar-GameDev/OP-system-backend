import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { DAILY_SESSION_TYPE } from '../src/common/session/daily-session';
import { AuthTokenService } from '../src/auth/auth-token.service';

/**
 * Admin management surface added for the admin dashboard: clinic onboarding,
 * doctor photo + positive-fee validation, and the doctor session schedule with
 * the no-overlap rule (same weekday + same session type). Scope is token-derived
 * exactly like the rest of the admin portal.
 */
describe('Admin management (clinics / doctors / sessions)', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let tokens: AuthTokenService;

  // Own hospital so listClinics (now hospital-scoped) stays isolated from the
  // seed's tenants. Both clinics belong to it; the admin token carries it.
  const HOSPITAL = 'mgmt-hosp';
  const CLINIC_A = 'mgmt-clinic-a';
  const CLINIC_B = 'mgmt-clinic-b';
  const DOCTOR_B = 'mgmt-doc-b';
  let adminAToken = '';
  const createdClinicIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    tokens = app.get(AuthTokenService);

    await cleanup();
    await prisma.hospital.upsert({
      where: { id: HOSPITAL },
      update: {},
      create: { id: HOSPITAL, name: 'Mgmt Hospital' },
    });
    await prisma.clinic.createMany({
      data: [
        { id: CLINIC_A, hospitalId: HOSPITAL, name: 'Mgmt Clinic A' },
        { id: CLINIC_B, hospitalId: HOSPITAL, name: 'Mgmt Clinic B' },
      ],
    });
    await prisma.doctor.create({ data: { id: DOCTOR_B, clinicId: CLINIC_B, name: 'Dr B' } });
    adminAToken = tokens.sign({ sub: 'mgmt-admin-a', role: 'ADMIN', clinicId: CLINIC_A, hospitalId: HOSPITAL });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    const ids = [CLINIC_A, CLINIC_B, ...createdClinicIds];
    await prisma.doctorSession.deleteMany({ where: { doctor: { clinicId: { in: ids } } } });
    await prisma.doctor.deleteMany({ where: { clinicId: { in: ids } } });
    await prisma.staff.deleteMany({ where: { clinicId: { in: ids } } });
    await prisma.clinic.deleteMany({ where: { id: { in: ids } } });
    await prisma.clinic.deleteMany({ where: { hospitalId: HOSPITAL } });
    await prisma.hospital.deleteMany({ where: { id: HOSPITAL } });
  }

  function adminFetch(path: string, init: RequestInit = {}, token = adminAToken) {
    return fetch(`${url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  }

  async function newDoctor(body: Record<string, unknown>) {
    const res = await adminFetch('/admin/doctors', { method: 'POST', body: JSON.stringify(body) });
    return res;
  }

  it('clinic onboarding: create + list includes the new clinic', async () => {
    const res = await adminFetch('/admin/clinics', {
      method: 'POST',
      body: JSON.stringify({ name: 'Brand New Clinic', address: '1 New St' }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; name: string };
    createdClinicIds.push(created.id);
    expect(created.name).toBe('Brand New Clinic');

    const list = (await (await adminFetch('/admin/clinics')).json()) as { id: string }[];
    expect(list.some((c) => c.id === created.id)).toBe(true);
  });

  it('doctor: stores photoUrl and rejects non-positive fee', async () => {
    const ok = await newDoctor({ name: 'Dr Photo', consultationFee: 500, photoUrl: 'https://x/p.png' });
    expect(ok.status).toBe(201);
    const doc = (await ok.json()) as { id: string; photoUrl: string; clinicId: string };
    expect(doc.photoUrl).toBe('https://x/p.png');
    expect(doc.clinicId).toBe(CLINIC_A);

    const negative = await newDoctor({ name: 'Dr Bad', consultationFee: -10 });
    expect(negative.status).toBe(400);
    const zero = await newDoctor({ name: 'Dr Zero', consultationFee: 0 });
    expect(zero.status).toBe(400);

    await prisma.doctor.delete({ where: { id: doc.id } });
  });

  it('sessions: one per weekday — a second session on a shared day is rejected', async () => {
    const docRes = await newDoctor({ name: 'Dr Sched', consultationFee: 300 });
    const doc = (await docRes.json()) as { id: string };

    const mk = (body: Record<string, unknown>) =>
      adminFetch(`/admin/doctors/${doc.id}/sessions`, { method: 'POST', body: JSON.stringify(body) });

    const first = await mk({ startTime: '09:00', maxTokens: 20, daysOfWeek: [1, 2, 3] });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { id: string; daysOfWeek: number[] };
    expect(firstBody.daysOfWeek).toEqual([1, 2, 3]);

    // Sharing Tuesday(2) -> 400. A doctor consults ONE session per day, so the
    // session type is no longer an escape hatch for a second block.
    const clash = await mk({ startTime: '11:00', maxTokens: 10, daysOfWeek: [2, 4] });
    expect(clash.status).toBe(400);

    // Previously allowed by declaring it an EVENING session — now still a clash.
    const sameDays = await mk({ sessionType: 'EVENING', startTime: '17:00', maxTokens: 12, daysOfWeek: [1, 2, 3] });
    expect(sameDays.status).toBe(400);

    // Disjoint days -> allowed.
    const other = await mk({ startTime: '09:00', maxTokens: 8, daysOfWeek: [4, 5] });
    expect(other.status).toBe(201);

    // A client still sending sessionType is accepted; the value is ignored and
    // the row is stored pinned, so old reception builds keep working.
    const stored = await prisma.doctorSession.findMany({ where: { doctorId: doc.id } });
    expect(stored.every((r) => r.sessionType === DAILY_SESSION_TYPE)).toBe(true);

    // bad inputs
    expect((await mk({ startTime: '25:00', maxTokens: 5, daysOfWeek: [6] })).status).toBe(400);
    expect((await mk({ startTime: '08:00', maxTokens: 0, daysOfWeek: [6] })).status).toBe(400);
    expect((await mk({ startTime: '08:00', maxTokens: 5, daysOfWeek: [] })).status).toBe(400);

    const list = (await (await adminFetch(`/admin/doctors/${doc.id}/sessions`)).json()) as unknown[];
    expect(list.length).toBe(2);

    await prisma.doctorSession.deleteMany({ where: { doctorId: doc.id } });
    await prisma.doctor.delete({ where: { id: doc.id } });
  });

  it('session scope: cannot manage sessions of another clinic’s doctor (403)', async () => {
    const res = await adminFetch(`/admin/doctors/${DOCTOR_B}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ sessionType: 'MORNING', startTime: '09:00', maxTokens: 5, daysOfWeek: [1] }),
    });
    expect(res.status).toBe(403);
    expect(await prisma.doctorSession.count({ where: { doctorId: DOCTOR_B } })).toBe(0);
  });
});
