import { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { toPublicDoctor } from '../src/discovery/discovery.dto';

describe('Discovery — public, no auth, no auth-field leakage (real Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let url: string;

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
  });

  afterAll(async () => {
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
});
