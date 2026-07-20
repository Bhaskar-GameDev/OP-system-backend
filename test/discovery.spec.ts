import { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BookingSource, BookingStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { toPublicDoctor } from '../src/discovery/discovery.dto';

/** Local-calendar YYYY-MM-DD — mirrors the service (never UTC). */
function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

describe('Discovery — public, no auth, no auth-field leakage (real Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let url: string;
  const PATIENT_ID = 'disc-pt-1';

  // Sessions on EVERY weekday so the next-7-days window always has entries
  // regardless of what day the test runs.
  const MORNING_MAX = 5;
  const EVENING_MAX = 3;

  const CLINIC_ID = 'disc-clinic';
  const DOCTOR_ID = 'disc-doctor';
  const SECRET_HASH = 'super-secret-bcrypt-hash';
  const SECRET_USERNAME = 'dr.house.login';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    prisma = app.get(PrismaService);

    await prisma.clinic.upsert({
      where: { id: CLINIC_ID },
      create: { id: CLINIC_ID, name: 'Discovery Clinic', address: '12 Main St', contactNumber: '555-1000' },
      update: {},
    });
    await prisma.doctor.upsert({
      where: { id: DOCTOR_ID },
      create: {
        id: DOCTOR_ID,
        clinicId: CLINIC_ID,
        name: 'Gregory House',
        specialization: 'Diagnostics',
        consultationFee: 700,
        username: SECRET_USERNAME,
        passwordHash: SECRET_HASH,
      },
      update: { username: SECRET_USERNAME, passwordHash: SECRET_HASH },
    });

    // Clean any stale bookings from a prior run (capacity is DB-derived now).
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR_ID } });
    await prisma.patient.upsert({
      where: { id: PATIENT_ID },
      create: { id: PATIENT_ID, name: 'Disc Patient', mobile: `7${Date.now()}` },
      update: {},
    });

    // Recurring weekly sessions on all 7 days (idempotent: clear then create).
    await prisma.doctorSession.deleteMany({ where: { doctorId: DOCTOR_ID } });
    await prisma.doctorSession.createMany({
      data: [
        { doctorId: DOCTOR_ID, sessionType: 'MORNING', startTime: '09:00', maxTokens: MORNING_MAX, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] },
        { doctorId: DOCTOR_ID, sessionType: 'EVENING', startTime: '17:00', maxTokens: EVENING_MAX, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] },
      ],
    });
  });

  afterAll(async () => {
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR_ID } });
    await prisma.patient.deleteMany({ where: { id: PATIENT_ID } });
    await prisma.doctorSession.deleteMany({ where: { doctorId: DOCTOR_ID } });
    await prisma.doctor.deleteMany({ where: { id: DOCTOR_ID } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC_ID } });
    await app.close();
  });

  it('unauthenticated search returns doctors (case-insensitive) with no auth fields', async () => {
    const res = await fetch(`${url}/doctors?query=house`); // lowercase vs "House"
    expect(res.status).toBe(200);
    const body = await res.json();
    const raw = JSON.stringify(body);

    expect(body.items.length).toBeGreaterThanOrEqual(1);
    const doc = body.items.find((d: { id: string }) => d.id === DOCTOR_ID);
    expect(doc.name).toBe('Gregory House');
    expect(doc.consultationFee).toBe(700);

    // no trace of auth/internal fields anywhere in the serialized body
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('password_hash');
    expect(raw).not.toContain(SECRET_HASH);
    expect(raw).not.toContain('username');
    expect(raw).not.toContain(SECRET_USERNAME);
  });

  it('unauthenticated specialization search + doctor profile + clinic view all work', async () => {
    const bySpec = await fetch(`${url}/doctors?query=diagnostics`);
    expect((await bySpec.json()).items.some((d: { id: string }) => d.id === DOCTOR_ID)).toBe(true);

    const profile = await fetch(`${url}/doctors/${DOCTOR_ID}`);
    expect(profile.status).toBe(200);
    const pj = await profile.json();
    expect(pj.consultationFee).toBe(700);
    expect(pj.clinic.name).toBe('Discovery Clinic');
    expect(JSON.stringify(pj)).not.toContain(SECRET_HASH);
    expect(JSON.stringify(pj)).not.toContain(SECRET_USERNAME);

    const clinic = await fetch(`${url}/clinics/${CLINIC_ID}`);
    expect(clinic.status).toBe(200);
    expect((await clinic.json()).address).toBe('12 Main St');
  });

  it('pagination metadata is returned and page size is capped', async () => {
    const res = await fetch(`${url}/doctors?query=&page=1&pageSize=999`);
    const body = await res.json();
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(50); // MAX_PAGE_SIZE cap
    expect(typeof body.total).toBe('number');
  });

  it('mapper cannot leak auth fields even when a RAW prisma row is forced through it', async () => {
    // fetch the real row WITH the secrets, then deliberately try to push it through
    const rawDoctor = await prisma.doctor.findUniqueOrThrow({ where: { id: DOCTOR_ID } });
    expect(rawDoctor.passwordHash).toBe(SECRET_HASH); // secrets really are present on the input

    const projected = toPublicDoctor(rawDoctor);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain(SECRET_HASH);
    expect(serialized).not.toContain(SECRET_USERNAME);
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('username');
    // and the projection is a fresh object — not the same reference
    expect(projected).not.toBe(rawDoctor);
  });

  it('schedule endpoint returns weekly templates + next-7-days availability, no auth leakage', async () => {
    const res = await fetch(`${url}/doctors/${DOCTOR_ID}/schedule`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.doctorId).toBe(DOCTOR_ID);
    expect(body.consultationFee).toBe(700);
    expect(body.photoUrl).toBeNull();
    expect(body.clinic.name).toBe('Discovery Clinic');

    // weekly: both standing templates, each carrying its capacity + days
    expect(body.weekly).toHaveLength(2);
    const morning = body.weekly.find((w: { sessionType: string }) => w.sessionType === 'MORNING');
    expect(morning.startTime).toBe('09:00');
    expect(morning.maxTokens).toBe(MORNING_MAX);
    expect(morning.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);

    // upcoming: 7 days × 2 sessions/day, all empty so all available
    expect(body.upcoming).toHaveLength(14);
    expect(body.upcoming.every((u: { available: boolean }) => u.available)).toBe(true);
    expect(body.upcoming.every((u: { tokensIssued: number }) => u.tokensIssued === 0)).toBe(true);
    // sorted by date then start time
    const keys = body.upcoming.map((u: { date: string; startTime: string }) => `${u.date} ${u.startTime}`);
    expect(keys).toEqual([...keys].sort());

    expect(JSON.stringify(body)).not.toContain(SECRET_HASH);
    expect(JSON.stringify(body)).not.toContain(SECRET_USERNAME);
  });

  it('a session at maxTokens is reported unavailable', async () => {
    const today = ymdLocal(new Date());
    // Fill today's MORNING session to capacity with live bookings (capacity is
    // the count of non-cancelled bookings — so this is what a real fill looks
    // like, and a cancel would reopen a slot).
    await prisma.booking.createMany({
      data: Array.from({ length: MORNING_MAX }, () => ({
        patientId: PATIENT_ID,
        doctorId: DOCTOR_ID,
        source: BookingSource.APP,
        sessionDate: new Date(today),
        sessionType: 'MORNING' as const,
        status: BookingStatus.BOOKED,
      })),
    });

    const body = await (await fetch(`${url}/doctors/${DOCTOR_ID}/schedule`)).json();
    const todayMorning = body.upcoming.find(
      (u: { date: string; sessionType: string }) => u.date === today && u.sessionType === 'MORNING',
    );
    expect(todayMorning.tokensIssued).toBe(MORNING_MAX);
    expect(todayMorning.available).toBe(false);

    // a different session that day is untouched and still bookable
    const todayEvening = body.upcoming.find(
      (u: { date: string; sessionType: string }) => u.date === today && u.sessionType === 'EVENING',
    );
    expect(todayEvening.available).toBe(true);
  });

  it('schedule for an unknown doctor is 404', async () => {
    const res = await fetch(`${url}/doctors/does-not-exist/schedule`);
    expect(res.status).toBe(404);
  });
});
