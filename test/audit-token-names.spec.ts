import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SessionType } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuditService } from '../src/queue-engine/audit.service';
import { SessionClaims } from '../src/auth/auth-token.service';

/**
 * Audit-log patient-name resolution for TOKEN-addressed actions.
 *
 * DONE / SKIP / NO_SHOW are recorded against a session + token — only PRIORITY
 * and REINSERT carry a `bookingId`. The read side used to resolve the patient
 * name from `bookingId` alone, so every one of those rows rendered a nameless
 * patient in the reception Audit Log ("—"), which is useless for a compliance
 * trail: you could see that a token was marked no-show but not who it was.
 *
 * The fix resolves them from the (doctor, sessionDate, sessionType, token) the
 * row DOES carry. Because it is a READ-side fallback, it also repairs rows that
 * were written before the fix.
 */
describe('Audit log resolves patient names for token-addressed actions', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let audit: AuditService;

  const stamp = Date.now();
  const HOSP = `at-hosp-${stamp}`;
  const CLINIC = `at-clinic-${stamp}`;
  const DOCTOR = `at-doc-${stamp}`;
  const OTHER_DOCTOR = `at-doc2-${stamp}`;
  const PHONE = '9300009301';
  const OTHER_PHONE = '9300009302';

  const todayYmd = (): string => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const staff: SessionClaims = {
    sub: `at-staff-${stamp}`,
    role: 'STAFF',
    clinicId: CLINIC,
  } as SessionClaims;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    prisma = app.get(PrismaService);
    audit = app.get(AuditService);

    await cleanup();
    await prisma.hospital.create({ data: { id: HOSP, name: 'AT Hosp' } });
    await prisma.clinic.create({ data: { id: CLINIC, hospitalId: HOSP, name: 'AT Clinic' } });
    await prisma.doctor.createMany({
      data: [
        { id: DOCTOR, clinicId: CLINIC, name: 'AT Dr', specialization: 'GP', consultationFee: 100, avgConsultMinutes: 10 },
        { id: OTHER_DOCTOR, clinicId: CLINIC, name: 'AT Dr2', specialization: 'GP', consultationFee: 100, avgConsultMinutes: 10 },
      ],
    });
    await prisma.staff.create({
      data: { id: staff.sub, hospitalId: HOSP, clinicId: CLINIC, name: 'AT Desk', role: 'RECEPTIONIST', username: `at-user-${stamp}`, loginCredentials: 'x' },
    });

    const p1 = await prisma.patient.create({ data: { mobile: PHONE, name: 'Named Patient' }, select: { id: true } });
    const p2 = await prisma.patient.create({ data: { mobile: OTHER_PHONE, name: 'Other Patient' }, select: { id: true } });

    // Two bookings holding the SAME token number under DIFFERENT doctors — so a
    // resolver keyed only on the token string would pick the wrong patient.
    await prisma.booking.create({
      data: { patientId: p1.id, doctorId: DOCTOR, source: 'WALK_IN', tokenNumber: 'W001', sessionDate: new Date(todayYmd()), sessionType: SessionType.MORNING, status: 'COMPLETED' },
    });
    await prisma.booking.create({
      data: { patientId: p2.id, doctorId: OTHER_DOCTOR, source: 'WALK_IN', tokenNumber: 'W001', sessionDate: new Date(todayYmd()), sessionType: SessionType.MORNING, status: 'COMPLETED' },
    });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await prisma.auditLog.deleteMany({ where: { doctorId: { in: [DOCTOR, OTHER_DOCTOR] } } }).catch(() => undefined);
    await prisma.booking.deleteMany({ where: { doctorId: { in: [DOCTOR, OTHER_DOCTOR] } } }).catch(() => undefined);
    await prisma.patient.deleteMany({ where: { mobile: { in: [PHONE, OTHER_PHONE] } } }).catch(() => undefined);
    await prisma.staff.deleteMany({ where: { id: staff.sub } }).catch(() => undefined);
    await prisma.doctor.deleteMany({ where: { id: { in: [DOCTOR, OTHER_DOCTOR] } } }).catch(() => undefined);
    await prisma.clinic.deleteMany({ where: { id: CLINIC } }).catch(() => undefined);
    await prisma.hospital.deleteMany({ where: { id: HOSP } }).catch(() => undefined);
  }

  const record = (action: 'DONE' | 'SKIP' | 'NO_SHOW', token: string) =>
    audit.record(staff, {
      action,
      doctorId: DOCTOR,
      sessionDate: todayYmd(),
      sessionType: SessionType.MORNING,
      token,
    });

  it('names the patient for DONE / SKIP / NO_SHOW rows that carry no bookingId', async () => {
    await record('DONE', 'W001');
    await record('SKIP', 'W001');
    await record('NO_SHOW', 'W001');

    const page = await audit.query(staff, { limit: 25, offset: 0 });
    const rows = page.entries.filter((e) => e.token === 'W001');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.patientName).toBe('Named Patient');
    }
    expect(rows.map((r) => r.action).sort()).toEqual(['DONE', 'NO_SHOW', 'SKIP']);
  });

  it('scopes the lookup to the row’s own session, not just the token string', async () => {
    // The other doctor holds token W001 too; the entries above are all against
    // DOCTOR, so none of them may resolve to the other doctor's patient.
    const page = await audit.query(staff, { limit: 25, offset: 0 });
    const names = page.entries.filter((e) => e.token === 'W001').map((e) => e.patientName);
    expect(names).not.toContain('Other Patient');
  });

  it('leaves the name null when no booking matches the token', async () => {
    await record('DONE', 'W999'); // never issued
    const page = await audit.query(staff, { limit: 25, offset: 0 });
    const row = page.entries.find((e) => e.token === 'W999');
    expect(row).toBeDefined();
    expect(row!.patientName).toBeNull();
  });
});
