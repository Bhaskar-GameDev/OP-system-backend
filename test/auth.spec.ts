import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { StaffRole } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { AuthTokenService } from '../src/auth/auth-token.service';
import { PasswordService } from '../src/auth/password.service';
import { SMS_SENDER, SmsSender } from '../src/auth/sms.sender';
import { RedisService } from '../src/common/redis/redis.service';

class CapturingSms implements SmsSender {
  last?: { mobile: string; otp: string };
  texts: { mobile: string; message: string }[] = [];
  async sendOtp(mobile: string, otp: string): Promise<void> {
    this.last = { mobile, otp };
  }
  async sendText(mobile: string, message: string): Promise<void> {
    this.texts.push({ mobile, message });
  }
}

/**
 * Step 4 — Auth Service. OTP (with attempt cap + send-rate limit), bcrypt
 * username/password login for staff & doctors, role-bearing tokens.
 */
describe('AuthService (real Redis + Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let tokens: AuthTokenService;
  let passwords: PasswordService;
  let redis: RedisService;
  const sms = new CapturingSms();

  const CLINIC_ID = 'auth-clinic';
  const MOBILES = ['9100000001', '9100000002', '9100000003'];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SMS_SENDER)
      .useValue(sms)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();

    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    tokens = app.get(AuthTokenService);
    passwords = app.get(PasswordService);
    redis = app.get(RedisService);

    await cleanup();
    await prisma.clinic.upsert({
      where: { id: CLINIC_ID },
      create: { id: CLINIC_ID, name: 'Auth Clinic' },
      update: {},
    });
    await prisma.staff.create({
      data: {
        clinicId: CLINIC_ID,
        name: 'Reception 1',
        role: StaffRole.RECEPTIONIST,
        username: 'recep1',
        loginCredentials: await passwords.hash('s3cret'),
      },
    });
    await prisma.doctor.create({
      data: {
        clinicId: CLINIC_ID,
        name: 'Dr Auth',
        username: 'dr.auth',
        passwordHash: await passwords.hash('docpw'),
      },
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.clinic.deleteMany({ where: { id: CLINIC_ID } });
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await prisma.staff.deleteMany({ where: { clinicId: CLINIC_ID } });
    await prisma.doctor.deleteMany({ where: { clinicId: CLINIC_ID } });
    await prisma.patient.deleteMany({ where: { mobile: { in: MOBILES } } });
    // clear OTP send-rate / code / attempts keys (TTL would otherwise leak across runs)
    const keys = MOBILES.flatMap((m) => [
      `pfos:otp:sends:${m}`,
      `pfos:otp:code:${m}`,
      `pfos:otp:attempts:${m}`,
    ]);
    await redis.redis.del(...keys);
  }

  it('patient OTP happy path -> PATIENT token, patient upserted', async () => {
    const mobile = MOBILES[0];
    await auth.requestPatientOtp(mobile);
    const otp = sms.last!.otp;
    expect(otp).toMatch(/^\d{6}$/);

    const res = await auth.verifyPatientOtp(mobile, otp);
    expect(res.role).toBe('PATIENT');
    const claims = tokens.verify(res.token);
    expect(claims.role).toBe('PATIENT');
    expect(claims.sub).toBe(res.sub);

    const patient = await prisma.patient.findUnique({ where: { mobile } });
    expect(patient?.id).toBe(res.sub);
  });

  it('OTP locks after 5 wrong attempts and is then burned', async () => {
    const mobile = MOBILES[1];
    await auth.requestPatientOtp(mobile);
    const correct = sms.last!.otp;
    const wrong = correct === '000000' ? '111111' : '000000';

    // attempts 1-4: rejected but OTP still alive
    for (let i = 0; i < 4; i++) {
      await expect(auth.verifyPatientOtp(mobile, wrong)).rejects.toThrow(
        /incorrect OTP/,
      );
    }
    // 5th wrong: lockout, OTP invalidated
    await expect(auth.verifyPatientOtp(mobile, wrong)).rejects.toThrow(
      /invalidated/,
    );
    // even the correct code no longer works — must request a fresh one
    await expect(auth.verifyPatientOtp(mobile, correct)).rejects.toThrow(
      /no active OTP/,
    );
  });

  it('OTP send is rate-limited per mobile', async () => {
    const mobile = MOBILES[2];
    for (let i = 0; i < 5; i++) {
      await auth.requestPatientOtp(mobile); // 5 allowed
    }
    await expect(auth.requestPatientOtp(mobile)).rejects.toThrow(
      /too many OTP requests/,
    );
  });

  it('staff login: correct password -> STAFF token; wrong -> 401', async () => {
    const res = await auth.staffLogin('recep1', 's3cret');
    expect(res.role).toBe('STAFF');
    const claims = tokens.verify(res.token);
    expect(claims.role).toBe('STAFF');
    expect(claims.clinicId).toBe(CLINIC_ID);

    await expect(auth.staffLogin('recep1', 'wrong')).rejects.toThrow(
      /invalid credentials/,
    );
    await expect(auth.staffLogin('nobody', 's3cret')).rejects.toThrow(
      /invalid credentials/,
    );
  });

  it('doctor login: correct password -> DOCTOR token; wrong -> 401', async () => {
    const res = await auth.doctorLogin('dr.auth', 'docpw');
    expect(res.role).toBe('DOCTOR');
    const claims = tokens.verify(res.token);
    expect(claims.role).toBe('DOCTOR');
    expect(claims.doctorId).toBe(res.sub);

    await expect(auth.doctorLogin('dr.auth', 'nope')).rejects.toThrow(
      /invalid credentials/,
    );
  });

  it('passwords are bcrypt-hashed, never stored in plaintext', async () => {
    const staff = await prisma.staff.findUniqueOrThrow({ where: { username: 'recep1' } });
    expect(staff.loginCredentials).not.toBe('s3cret');
    expect(staff.loginCredentials.startsWith('$2')).toBe(true); // bcrypt prefix
  });
});
