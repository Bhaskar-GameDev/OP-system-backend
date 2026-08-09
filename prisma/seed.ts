/**
 * Demo seed for Patient Flow OS. DEVELOPMENT AND TEST ONLY.
 *
 * Populates a realistic, demo-ready dataset: 2 clinics, 5 doctors across
 * specialties (ONE continuous session per doctor per day), 12 patients, and a
 * spread of bookings (completed / confirmed / expired) plus matching payments
 * and audit entries so booking history and the audit log are never empty.
 *
 * Credentials: NONE are hardcoded. Passwords are generated per run and printed
 * once to the developer's terminal, or pinned via SEED_*_PASSWORD. Privileged
 * account ids are generated too. Nothing in this file is a usable credential.
 *
 * Idempotent: rows are upserted by a natural key — staff and doctors by their
 * unique username, patients by mobile — so re-running never duplicates.
 *
 * Refuses to run when NODE_ENV=production. See assertSafeToSeed().
 */
import {
  PrismaClient,
  StaffRole,
  Gender,
  BookingSource,
  BookingStatus,
  PaymentStatus,
  QueuePolicyMode,
  SessionType,
  TokenResetPolicy,
} from '@prisma/client';
import { DAILY_SESSION_TYPE } from '../src/common/session/daily-session';
import * as bcrypt from 'bcrypt';
import { randomBytes, randomUUID } from 'node:crypto';

const prisma = new PrismaClient();

// ── Ids ──────────────────────────────────────────────────────────────────────
// Hospitals and clinics keep STABLE ids: HOSPITAL_A's is a production
// identifier written by migration 20260626130000 and used as a column default,
// and the clinic ids are referenced by local dev tooling. Neither is a
// credential-bearing account.
//
// PRIVILEGED ACCOUNTS (staff + doctors) no longer have fixed ids. They are
// generated per install and re-adopted from the database by their unique
// username, so no privileged account is guessable from this file.

// Hospitals (tenants). HOSPITAL_A's id MUST match the migration backfill id so a
// fresh migrate+seed keeps Clinic A under the same tenant.
const HOSPITAL_A = '00000000-0000-0000-0000-0000000000a1'; // City Health Network
const HOSPITAL_B = '00000000-0000-0000-0000-0000000000b1'; // Apollo Group

const CLINIC_A = '00000000-0000-0000-0000-000000000001'; // City Care Clinic    @ HOSPITAL_A
const CLINIC_C = '00000000-0000-0000-0000-000000000013'; // Metro Care Clinic   @ HOSPITAL_A (2nd clinic -> exercises ADMIN multi-clinic scope)
// Privileged account ids are GENERATED, never fixed. They used to be
// '00000000-0000-0000-0000-0000000000XX', which made every privileged demo
// account guessable in any database this seed had touched. resolveDoctorIdentities()
// adopts the existing id when a doctor with that username is already present, so
// re-running the seed stays idempotent without a predictable key.
let DR_SMITH: string = randomUUID();

const CLINIC_B = '00000000-0000-0000-0000-000000000010'; // Apollo Hospitals    @ HOSPITAL_B

let DR_MEERA: string = randomUUID(); // Pediatrics   @ CLINIC_A / HOSPITAL_A
let DR_ARJUN: string = randomUUID(); // ENT          @ CLINIC_A / HOSPITAL_A
let DR_KAVYA: string = randomUUID(); // Orthopedics  @ CLINIC_B / HOSPITAL_B
let DR_SUNITA: string = randomUUID(); // Dermatology  @ CLINIC_B / HOSPITAL_B
// Overlapping shape on purpose: HOSPITAL_A also has a Dermatologist with a
// near-identical name, in its 2nd clinic — so any cross-tenant leak is obvious.
let DR_SUNITA_A: string = randomUUID(); // Dermatology @ CLINIC_C / HOSPITAL_A

/**
 * Hard refusal to run against production.
 *
 * This seed creates staff accounts with documented demo passwords AND issues
 * `deleteMany` against bookings, booking history, sessions, audit logs, doctors
 * and clinics. Running it on a live hospital database means predictable
 * super-admin credentials plus destroyed patient bookings.
 *
 * The guard lives HERE, inside the seed itself, rather than only in the Docker
 * entrypoint or Compose file — the risk is a human typing `npm run db:seed`
 * against a production DATABASE_URL, and no amount of container configuration
 * prevents that. There is deliberately NO override flag: nothing this script
 * does is ever wanted in production.
 */
function assertSafeToSeed(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to seed: NODE_ENV=production. This seed creates demo accounts with ' +
        'known passwords and deletes live rows. It must never run against a production ' +
        'database. If this is a non-production environment, set NODE_ENV appropriately.',
    );
  }
}

/**
 * Development credential for a seeded account.
 *
 * There is NO hardcoded fallback any more. The previous design shipped a fixed
 * literal password per role, which meant the credential for every privileged
 * demo account — including a hospital-wide super-admin — was a constant known
 * to anyone who could read this file, and this file lives in a public
 * repository. Swapping one fixed string for another would not have fixed it.
 *
 * (The old values are deliberately not repeated here: a test asserts that this
 * file contains none of them, so naming them would defeat the check.)
 *
 * Behaviour now:
 *   - `SEED_*_PASSWORD` set  -> use it. This is the deterministic path, for CI
 *     and for a developer who wants a stable local login across re-seeds.
 *   - unset                  -> generate a fresh random password for this run.
 *
 * Randomly generated values are collected in `generatedCredentials` and printed
 * once, at the end of the run, to the developer's terminal only. They are never
 * written to a file, never committed, and never reachable in production because
 * `assertSafeToSeed()` stops the script long before this is called.
 */
const generatedCredentials: Array<{ account: string; envVar: string; password: string }> = [];

function devPassword(envVar: string, account: string): string {
  const supplied = (process.env[envVar] ?? '').trim();
  if (supplied.length > 0) return supplied;

  // 24 bytes of CSPRNG output, base64url. Not memorable by design — a developer
  // reads it from the summary below or pins one via the environment variable.
  const generated = randomBytes(24).toString('base64url');
  generatedCredentials.push({ account, envVar, password: generated });
  return generated;
}

/**
 * Print the credentials generated during this run, once, at the end.
 *
 * Deliberately `console.log` from a one-shot CLI script and NOT the application
 * logger: this must never enter the server's log stream, a log shipper, or any
 * retained store. It is a message to the human who just typed `npm run db:seed`.
 *
 * Doubly guarded on production even though the script cannot reach here in
 * production — the cost of the check is nothing and the cost of being wrong is
 * a credential in a production log.
 */
function reportGeneratedCredentials(): void {
  if (process.env.NODE_ENV === 'production') return;
  if (generatedCredentials.length === 0) {
    console.log('  Passwords: taken from SEED_*_PASSWORD environment variables.');
    return;
  }
  console.log('');
  console.log('  ── DEVELOPMENT CREDENTIALS (generated this run) ──────────────');
  console.log('  Local development only. NOT valid anywhere else, and NOT stored.');
  console.log('  Re-running the seed generates new ones. To pin a value instead,');
  console.log('  set the matching environment variable before seeding.');
  console.log('');
  for (const c of generatedCredentials) {
    console.log(`    ${c.account.padEnd(28)} ${c.password}   (pin with ${c.envVar})`);
  }
  console.log('  ──────────────────────────────────────────────────────────────');
}

/** Local calendar date at midnight — matches how sessions are keyed (@db.Date). */
function today(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

async function seedHospitals(): Promise<void> {
  await prisma.hospital.upsert({
    where: { id: HOSPITAL_A },
    update: { name: 'City Health Network' },
    create: { id: HOSPITAL_A, name: 'City Health Network' },
  });
  await prisma.hospital.upsert({
    where: { id: HOSPITAL_B },
    update: { name: 'Apollo Group' },
    create: { id: HOSPITAL_B, name: 'Apollo Group' },
  });
}

async function seedClinics(): Promise<void> {
  await prisma.clinic.upsert({
    where: { id: CLINIC_A },
    update: { name: 'City Care Clinic', hospitalId: HOSPITAL_A },
    create: {
      id: CLINIC_A,
      hospitalId: HOSPITAL_A,
      name: 'City Care Clinic',
      address: '12 MG Road, Bengaluru',
      contactNumber: '+91-80-40001234',
    },
  });
  // 2nd clinic under HOSPITAL_A so an ADMIN's hospital-wide scope spans >1 clinic.
  await prisma.clinic.upsert({
    where: { id: CLINIC_C },
    update: { name: 'Metro Care Clinic', hospitalId: HOSPITAL_A },
    create: {
      id: CLINIC_C,
      hospitalId: HOSPITAL_A,
      name: 'Metro Care Clinic',
      address: '88 Brigade Road, Bengaluru',
      contactNumber: '+91-80-40005678',
    },
  });
  await prisma.clinic.upsert({
    where: { id: CLINIC_B },
    update: { name: 'Apollo Hospitals', hospitalId: HOSPITAL_B },
    create: {
      id: CLINIC_B,
      hospitalId: HOSPITAL_B,
      name: 'Apollo Hospitals',
      address: '21 Greams Lane, Chennai',
      contactNumber: '+91-44-28293333',
    },
  });
}

/**
 * Seeded privileged staff.
 *
 * Upserted by USERNAME, not by a hardcoded id. The ids used to be fixed values
 * of the form `00000000-0000-0000-0000-0000000000XX`, which made every
 * privileged demo account trivially identifiable — and guessable — in any
 * database this seed had ever touched. `username` is already `@unique` on this
 * table, so it is a proper natural key: the seed stays idempotent across
 * re-runs while the primary key is a real random UUID.
 *
 * Hospital and clinic ids are deliberately NOT randomised — see the note beside
 * their constants. HOSPITAL_A's id in particular is a production identifier
 * written by migration 20260626130000 and used as a column default.
 */
async function seedStaff(): Promise<void> {
  const receptionHash = await bcrypt.hash(devPassword('SEED_RECEPTION_PASSWORD', 'reception / reception2'), 12);
  const adminHash = await bcrypt.hash(devPassword('SEED_ADMIN_PASSWORD', 'admin / admin2'), 12);
  const superHash = await bcrypt.hash(devPassword('SEED_SUPERADMIN_PASSWORD', 'superadmin'), 12);

  const staff: Array<{
    username: string;
    name: string;
    role: StaffRole;
    hospitalId: string;
    clinicId: string;
    hash: string;
  }> = [
    { username: 'reception',  name: 'Front Desk',        role: StaffRole.RECEPTIONIST, hospitalId: HOSPITAL_A, clinicId: CLINIC_A, hash: receptionHash },
    { username: 'reception2', name: 'Apollo Front Desk', role: StaffRole.RECEPTIONIST, hospitalId: HOSPITAL_B, clinicId: CLINIC_B, hash: receptionHash },
    { username: 'admin',      name: 'Clinic Admin',      role: StaffRole.ADMIN,        hospitalId: HOSPITAL_A, clinicId: CLINIC_A, hash: adminHash },
    // ADMIN for HOSPITAL_B — so the demo has an admin per hospital and
    // cross-tenant isolation is exercisable by logging into each.
    { username: 'admin2',     name: 'Apollo Admin',      role: StaffRole.ADMIN,        hospitalId: HOSPITAL_B, clinicId: CLINIC_B, hash: adminHash },
    // "Super admin" is a NAME, not a role: StaffRole has no SUPERADMIN tier.
    // This is an ordinary ADMIN on HOSPITAL_A used by the admin dashboard.
    { username: 'superadmin', name: 'Super Admin',       role: StaffRole.ADMIN,        hospitalId: HOSPITAL_A, clinicId: CLINIC_A, hash: superHash },
  ];

  for (const m of staff) {
    await prisma.staff.upsert({
      where: { username: m.username },
      update: {
        loginCredentials: m.hash,
        name: m.name,
        role: m.role,
        hospitalId: m.hospitalId,
        clinicId: m.clinicId,
      },
      create: {
        id: randomUUID(),
        username: m.username,
        loginCredentials: m.hash,
        name: m.name,
        role: m.role,
        hospitalId: m.hospitalId,
        clinicId: m.clinicId,
      },
    });
  }
}

// Same-day model: the patient app's "Join Queue" auto-resolves TODAY's session,
// so every demo doctor gets at least one session that runs EVERY day of the week
// (daysOfWeek 0..6). That way the demo's same-day queue works no matter which
// day the seed is run/demoed on — no "no sessions today" dead end on a weekend.
// maxTokens is retained but is now informational ("expected load"), NOT a cap.
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

async function seedSchedules(): Promise<void> {
  // ONE session per doctor per day — no morning/evening split. sessionType is a
  // pinned constant (see common/session/daily-session.ts), never a time of day.
  // Doctor ids are resolved at runtime, so this list is built inside the function.
  const rows = [
    { id: 'demo-sess-smith-am', doctorId: DR_SMITH, sessionType: DAILY_SESSION_TYPE, startTime: '09:00', maxTokens: 20, daysOfWeek: EVERY_DAY },
    { id: 'demo-sess-meera-am', doctorId: DR_MEERA, sessionType: DAILY_SESSION_TYPE, startTime: '10:00', maxTokens: 18, daysOfWeek: EVERY_DAY },
    { id: 'demo-sess-arjun-am', doctorId: DR_ARJUN, sessionType: DAILY_SESSION_TYPE, startTime: '11:00', maxTokens: 16, daysOfWeek: EVERY_DAY },
    { id: 'demo-sess-kavya-pm', doctorId: DR_KAVYA, sessionType: DAILY_SESSION_TYPE, startTime: '09:00', maxTokens: 12, daysOfWeek: EVERY_DAY },
    { id: 'demo-sess-sunita-am', doctorId: DR_SUNITA, sessionType: DAILY_SESSION_TYPE, startTime: '09:30', maxTokens: 14, daysOfWeek: EVERY_DAY },
    { id: 'demo-sess-sunita-a-am', doctorId: DR_SUNITA_A, sessionType: DAILY_SESSION_TYPE, startTime: '10:30', maxTokens: 14, daysOfWeek: EVERY_DAY },
  ];
  // Dr Smith's old second (evening) block is explicitly removed, not just left
  // out: the seed is idempotent by id, so an existing row would otherwise
  // survive and break the one-session-per-day rule on a re-seed.
  await prisma.doctorSession.deleteMany({ where: { id: 'demo-sess-smith-pm' } });
  for (const r of rows) {
    const { id, ...data } = r;
    await prisma.doctorSession.upsert({ where: { id }, update: data, create: { id, ...data } });
  }
}

async function seedVoiceNumbers(): Promise<void> {
  const rows = [
    { id: 'demo-voice-a', didNumber: '+918040001234', clinicId: CLINIC_A, language: 'en' },
    { id: 'demo-voice-c', didNumber: '+918040005678', clinicId: CLINIC_C, language: 'en' },
    { id: 'demo-voice-b', didNumber: '+914428293333', clinicId: CLINIC_B, language: 'en' },
  ];
  for (const r of rows) {
    const { id, ...data } = r;
    await prisma.voiceNumber.upsert({ where: { id }, update: data, create: { id, ...data } });
  }
}

interface DoctorSeed {
  id: string;
  clinicId: string;
  name: string;
  specialization: string;
  fee: number;
  avg: number;
  username: string;
}

// Lazy: evaluated AFTER resolveDoctorIdentities() has assigned the doctor ids.
const DOCTORS = (): DoctorSeed[] => [
  { id: DR_SMITH, clinicId: CLINIC_A, name: 'Dr. Anil Smith', specialization: 'General Medicine', fee: 500, avg: 10, username: 'drsmith' },
  { id: DR_MEERA, clinicId: CLINIC_A, name: 'Dr. Meera Nair', specialization: 'Pediatrics', fee: 400, avg: 12, username: 'meera.nair' },
  { id: DR_ARJUN, clinicId: CLINIC_A, name: 'Dr. Arjun Rao', specialization: 'ENT', fee: 350, avg: 8, username: 'arjun.rao' },
  { id: DR_KAVYA, clinicId: CLINIC_B, name: 'Dr. Kavya Pillai', specialization: 'Orthopedics', fee: 700, avg: 15, username: 'kavya.pillai' },
  { id: DR_SUNITA, clinicId: CLINIC_B, name: 'Dr. Sunita Verma', specialization: 'Dermatology', fee: 600, avg: 10, username: 'sunita.verma' },
  // HOSPITAL_A, 2nd clinic — deliberately a Dermatologist named like CLINIC_B's
  // Dr. Sunita Verma, so a cross-tenant leak (mixing the two) is easy to spot.
  { id: DR_SUNITA_A, clinicId: CLINIC_C, name: 'Dr. Sunita Sharma', specialization: 'Dermatology', fee: 550, avg: 10, username: 'sunita.sharma' },
];

/**
 * Adopt existing ids for the seeded doctors, or keep the freshly generated ones.
 *
 * The seed must stay idempotent — `docker compose up` re-runs it — but its keys
 * are no longer predictable constants. `username` is `@unique` on `doctors`, so
 * it serves as the natural key: if a doctor with that username already exists we
 * reuse its primary key, and every downstream fixture (bookings, audit entries,
 * consultation notes) then points at the same row as before.
 *
 * Runs BEFORE any fixture array is evaluated; those arrays are lazy functions
 * for exactly this reason.
 */
async function resolveDoctorIdentities(): Promise<void> {
  const byUsername: Record<string, (id: string) => void> = {
    'drsmith': (id) => { DR_SMITH = id; },
    'meera.nair': (id) => { DR_MEERA = id; },
    'arjun.rao': (id) => { DR_ARJUN = id; },
    'kavya.pillai': (id) => { DR_KAVYA = id; },
    'sunita.verma': (id) => { DR_SUNITA = id; },
    'sunita.sharma': (id) => { DR_SUNITA_A = id; },
  };

  const existing = await prisma.doctor.findMany({
    where: { username: { in: Object.keys(byUsername) } },
    select: { id: true, username: true },
  });
  for (const row of existing) {
    if (row.username && byUsername[row.username]) byUsername[row.username](row.id);
  }
}

async function seedDoctors(): Promise<void> {
  // All seeded doctors share one development password: generated per run, or
  // pinned with SEED_DOCTOR_PASSWORD. See devPassword().
  const hash = await bcrypt.hash(devPassword('SEED_DOCTOR_PASSWORD', 'all seeded doctors'), 12);
  for (const d of DOCTORS()) {
    await prisma.doctor.upsert({
      where: { username: d.username },
      update: {
        clinicId: d.clinicId,
        name: d.name,
        specialization: d.specialization,
        consultationFee: d.fee,
        avgConsultMinutes: d.avg,
        username: d.username,
        passwordHash: hash,
      },
      create: {
        id: d.id,
        clinicId: d.clinicId,
        name: d.name,
        specialization: d.specialization,
        consultationFee: d.fee,
        avgConsultMinutes: d.avg,
        username: d.username,
        passwordHash: hash,
      },
    });

    // One session record for today (durable session metadata; the live ordering
    // itself lives in Redis and is built during the demo).
    await prisma.queueSession.upsert({
      where: {
        uq_session: { doctorId: d.id, sessionDate: today(), sessionType: DAILY_SESSION_TYPE },
      },
      update: {},
      create: {
        doctorId: d.id,
        sessionDate: today(),
        sessionType: DAILY_SESSION_TYPE,
        isOpen: true,
      },
    });
  }
}

interface PatientSeed {
  id: string;
  name: string;
  mobile: string;
  age: number;
  gender: Gender;
}

const PATIENTS: PatientSeed[] = [
  { id: 'demo-pt-01', name: 'Asha Rao', mobile: '9200000001', age: 34, gender: Gender.FEMALE },
  { id: 'demo-pt-02', name: 'Bilal Khan', mobile: '9200000002', age: 41, gender: Gender.MALE },
  { id: 'demo-pt-03', name: 'Catherine Dsouza', mobile: '9200000003', age: 28, gender: Gender.FEMALE },
  { id: 'demo-pt-04', name: 'Deepak Menon', mobile: '9200000004', age: 53, gender: Gender.MALE },
  { id: 'demo-pt-05', name: 'Esha Gupta', mobile: '9200000005', age: 6, gender: Gender.FEMALE },
  { id: 'demo-pt-06', name: 'Farhan Ali', mobile: '9200000006', age: 37, gender: Gender.MALE },
  { id: 'demo-pt-07', name: 'Gita Sharma', mobile: '9200000007', age: 62, gender: Gender.FEMALE },
  { id: 'demo-pt-08', name: 'Harish Kumar', mobile: '9200000008', age: 45, gender: Gender.MALE },
  { id: 'demo-pt-09', name: 'Irfan Sheikh', mobile: '9200000009', age: 19, gender: Gender.MALE },
  { id: 'demo-pt-10', name: 'Jaya Reddy', mobile: '9200000010', age: 30, gender: Gender.FEMALE },
  { id: 'demo-pt-11', name: 'Karan Malhotra', mobile: '9200000011', age: 9, gender: Gender.MALE },
  { id: 'demo-pt-12', name: 'Lakshmi Iyer', mobile: '9200000012', age: 48, gender: Gender.FEMALE },
];

async function seedPatients(): Promise<void> {
  for (const p of PATIENTS) {
    await prisma.patient.upsert({
      where: { mobile: p.mobile }, // mobile is the unique login identity
      update: { name: p.name, age: p.age, gender: p.gender },
      create: { id: p.id, name: p.name, mobile: p.mobile, age: p.age, gender: p.gender },
    });
  }
}

interface BookingSeed {
  id: string;
  patientId: string;
  doctorId: string;
  sessionType: SessionType;
  status: BookingStatus;
  token: string | null;
  fee: number; // rupees
  payment: PaymentStatus | null;
  paymentId: string | null;
  completed?: boolean; // set consultation timestamps + arrival
  // For completed rows: which past day the visit happened (0 = today) and the
  // realistic gaps, so analytics show sane numbers and a multi-day trend.
  dayOffset?: number; // days before today the session was held
  waitMinutes?: number; // booked -> consultation start (the patient's wait)
  consultMinutes?: number; // consultation start -> end (how long they were seen)
}

// A spread of states so history + audit are populated. Tokens are unique within
// a doctor's session. Completed visits are dated across the last few days (and
// each carries a real wait + consult gap) so the daily trend chart has multiple
// points and average-wait/consult come out positive and realistic.
// Lazy: evaluated AFTER resolveDoctorIdentities() has assigned the doctor ids.
const BOOKINGS = (): BookingSeed[] => [
  // Dr Smith — two seen today, two waiting
  { id: 'demo-bk-01', patientId: 'demo-pt-01', doctorId: DR_SMITH, sessionType: DAILY_SESSION_TYPE, status: BookingStatus.COMPLETED, token: 'A001', fee: 500, payment: PaymentStatus.SUCCESS, paymentId: 'demo-pay-01', completed: true, dayOffset: 0, waitMinutes: 45, consultMinutes: 12 },
  { id: 'demo-bk-02', patientId: 'demo-pt-02', doctorId: DR_SMITH, sessionType: DAILY_SESSION_TYPE, status: BookingStatus.COMPLETED, token: 'A002', fee: 500, payment: PaymentStatus.SUCCESS, paymentId: 'demo-pay-02', completed: true, dayOffset: 0, waitMinutes: 30, consultMinutes: 10 },
  { id: 'demo-bk-03', patientId: 'demo-pt-03', doctorId: DR_SMITH, sessionType: DAILY_SESSION_TYPE, status: BookingStatus.BOOKED, token: 'A003', fee: 500, payment: PaymentStatus.SUCCESS, paymentId: 'demo-pay-03' },
  { id: 'demo-bk-04', patientId: 'demo-pt-04', doctorId: DR_SMITH, sessionType: DAILY_SESSION_TYPE, status: BookingStatus.BOOKED, token: 'A004', fee: 500, payment: PaymentStatus.SUCCESS, paymentId: 'demo-pay-04' },
  // Dr Smith — a failed/expired payment (never got a token)
  { id: 'demo-bk-05', patientId: 'demo-pt-06', doctorId: DR_SMITH, sessionType: DAILY_SESSION_TYPE, status: BookingStatus.EXPIRED, token: null, fee: 500, payment: PaymentStatus.FAILED, paymentId: 'demo-pay-05' },
  // Dr Meera (pediatrics) — seen yesterday, one waiting today
  { id: 'demo-bk-06', patientId: 'demo-pt-05', doctorId: DR_MEERA, sessionType: DAILY_SESSION_TYPE, status: BookingStatus.COMPLETED, token: 'A001', fee: 400, payment: PaymentStatus.SUCCESS, paymentId: 'demo-pay-06', completed: true, dayOffset: 1, waitMinutes: 60, consultMinutes: 15 },
  { id: 'demo-bk-07', patientId: 'demo-pt-11', doctorId: DR_MEERA, sessionType: DAILY_SESSION_TYPE, status: BookingStatus.BOOKED, token: 'A002', fee: 400, payment: PaymentStatus.SUCCESS, paymentId: 'demo-pay-07' },
  // Dr Kavya (ortho, clinic B) — evening, one waiting
  { id: 'demo-bk-08', patientId: 'demo-pt-08', doctorId: DR_KAVYA, sessionType: DAILY_SESSION_TYPE, status: BookingStatus.BOOKED, token: 'A001', fee: 700, payment: PaymentStatus.SUCCESS, paymentId: 'demo-pay-08' },
  // Dr Sunita (derma, clinic B) — seen two days ago
  { id: 'demo-bk-09', patientId: 'demo-pt-12', doctorId: DR_SUNITA, sessionType: DAILY_SESSION_TYPE, status: BookingStatus.COMPLETED, token: 'A001', fee: 600, payment: PaymentStatus.SUCCESS, paymentId: 'demo-pay-09', completed: true, dayOffset: 2, waitMinutes: 75, consultMinutes: 20 },
];

const DAY_MS = 86_400_000;

/** Local midnight of the given instant — matches how @db.Date is keyed. */
function startOfLocalDay(at: Date): Date {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Realistic consultation timestamps for a completed booking, anchored on `now`
 * so they are always in the PAST (createdAt < startedAt < endedAt) regardless of
 * when the seed runs:
 *   createdAt  = booked `waitMinutes` before the consult started
 *   startedAt  = consult began (ended `consultMinutes` later)
 *   endedAt    = ~30min ago on the offset day
 * sessionDate is the local calendar day of the visit.
 */
function completedTimes(b: BookingSeed): {
  createdAt: Date;
  startedAt: Date;
  endedAt: Date;
  sessionDate: Date;
} {
  const offset = b.dayOffset ?? 0;
  const endedAt = new Date(Date.now() - offset * DAY_MS - 30 * 60_000);
  const startedAt = new Date(endedAt.getTime() - (b.consultMinutes ?? 12) * 60_000);
  const createdAt = new Date(startedAt.getTime() - (b.waitMinutes ?? 45) * 60_000);
  return { createdAt, startedAt, endedAt, sessionDate: startOfLocalDay(endedAt) };
}

// bookingId -> the session date the booking was placed on. Populated by
// seedBookings and read by seedAudit so the audit row's date matches the visit.
const bookingSessionDate = new Map<string, Date>();

async function seedBookings(): Promise<void> {
  const d = today();
  bookingSessionDate.clear();

  // The seed writes FIXED token numbers, so it must clear anything already
  // holding one of those exact slots (unique: doctor+date+session+token).
  //
  // Scoped to the colliding slots ONLY — deliberately NOT "every booking for the
  // demo doctors in a 7-day window", which is what this used to do. The seed
  // re-runs on EVERY container start, so the broad delete silently destroyed
  // live bookings made during a demo: register a walk-in, restart the backend,
  // and the patient is gone from the DB while their token lingers in Redis
  // (Redis is untouched here), leaving phantom tokens in the reception/doctor
  // queues. Rows the seed owns are upserted by id below, so they need no delete.
  const seedSlots = BOOKINGS().map((b) => {
    const t = b.completed ? completedTimes(b) : null;
    return {
      doctorId: b.doctorId,
      sessionDate: t ? t.sessionDate : d,
      sessionType: b.sessionType,
      tokenNumber: b.token,
    };
  });
  await prisma.booking.deleteMany({
    where: {
      OR: seedSlots,
      id: { notIn: BOOKINGS().map((b) => b.id) },
    },
  });

  // Drop any history rows for the demo bookings we are about to re-create.
  //
  // The archival sweep MOVES a settled booking: it appends to the append-only
  // booking_history and deletes the live row. Re-seeding then resurrects that
  // same stable id in `bookings`, so the next sweep tries to archive it a second
  // time and dies on booking_history's unique booking_id — wedging the archival
  // cron for good in any environment that re-seeds (the demo container re-seeds
  // on every start).
  //
  // Cleaning the history side here is what keeps the seed's contract — "run this
  // and the database is in a known good demo state" — true across the archival
  // boundary. Scoped to the demo ids on purpose: real archived history in a dev
  // database is left untouched, and archival's own no-update/no-delete invariant
  // (HA-3) is not weakened, because this is the seed's own data, not the sweep's.
  await prisma.bookingHistory.deleteMany({
    where: { bookingId: { in: BOOKINGS().map((b) => b.id) } },
  });

  // Live (not-completed) bookings sit in today's session; give them a createdAt
  // a little while ago so "today" is populated without inventing a consult.
  const liveCreatedAt = new Date(Date.now() - 25 * 60_000);

  for (const b of BOOKINGS()) {
    const t = b.completed ? completedTimes(b) : null;
    const sessionDate = t ? t.sessionDate : d;
    bookingSessionDate.set(b.id, sessionDate);

    const base = {
      patientId: b.patientId,
      doctorId: b.doctorId,
      source: BookingSource.APP,
      tokenNumber: b.token,
      sessionDate,
      sessionType: b.sessionType,
      status: b.status,
      // createdAt precedes the consult for completed rows; recent for live rows
      createdAt: t ? t.createdAt : liveCreatedAt,
      consultationStartedAt: t ? t.startedAt : null,
      consultationEndedAt: t ? t.endedAt : null,
      checkedInAt: t ? t.createdAt : null,
    };
    await prisma.booking.upsert({
      where: { id: b.id },
      update: base,
      create: { id: b.id, ...base },
    });

    if (b.payment && b.paymentId) {
      const amountPaise = b.fee * 100;
      await prisma.payment.upsert({
        where: { id: b.paymentId },
        update: { status: b.payment, amount: amountPaise },
        create: {
          id: b.paymentId,
          bookingId: b.id,
          amount: amountPaise,
          status: b.payment,
          razorpayOrderId: `order_demo_${b.id}`,
          razorpayPaymentId: b.payment === PaymentStatus.SUCCESS ? `pay_demo_${b.id}` : null,
        },
      });
      await prisma.booking.update({ where: { id: b.id }, data: { paymentId: b.paymentId } });
    }
  }
}

interface AuditSeed {
  id: string;
  doctorId: string;
  clinicId: string;
  action: string;
  token: string;
  bookingId: string;
  sessionType: SessionType;
}

// DONE entries for the completed consultations + one SKIP, so the audit log
// shows real who-did-what activity.
// Lazy: evaluated AFTER resolveDoctorIdentities() has assigned the doctor ids.
const AUDIT = (): AuditSeed[] => [
  { id: 'demo-audit-01', doctorId: DR_SMITH, clinicId: CLINIC_A, action: 'DONE', token: 'A001', bookingId: 'demo-bk-01', sessionType: DAILY_SESSION_TYPE },
  { id: 'demo-audit-02', doctorId: DR_SMITH, clinicId: CLINIC_A, action: 'DONE', token: 'A002', bookingId: 'demo-bk-02', sessionType: DAILY_SESSION_TYPE },
  { id: 'demo-audit-03', doctorId: DR_SMITH, clinicId: CLINIC_A, action: 'SKIP', token: 'A003', bookingId: 'demo-bk-03', sessionType: DAILY_SESSION_TYPE },
  { id: 'demo-audit-04', doctorId: DR_MEERA, clinicId: CLINIC_A, action: 'DONE', token: 'A001', bookingId: 'demo-bk-06', sessionType: DAILY_SESSION_TYPE },
  { id: 'demo-audit-05', doctorId: DR_SUNITA, clinicId: CLINIC_B, action: 'DONE', token: 'A001', bookingId: 'demo-bk-09', sessionType: DAILY_SESSION_TYPE },
];

async function seedAudit(): Promise<void> {
  // Resolve the desk operator by username: staff ids are generated now, so this
  // fixture cannot reference a hardcoded one.
  const deskOperator = await prisma.staff.findUnique({
    where: { username: 'reception' },
    select: { id: true },
  });
  if (!deskOperator) throw new Error('seedAudit: reception staff not found — seedStaff must run first');

  for (const a of AUDIT()) {
    // Match the audit row's date to the booking's actual session day (completed
    // visits may be on past days), falling back to today for any unmapped id.
    const sessionDate = bookingSessionDate.get(a.bookingId) ?? today();
    const data = {
      actorId: deskOperator.id, // recorded against the desk operator
      actorRole: 'STAFF',
      clinicId: a.clinicId,
      action: a.action,
      doctorId: a.doctorId,
      sessionDate,
      sessionType: a.sessionType,
      token: a.token,
      bookingId: a.bookingId,
      metadata: { demo: true },
    };
    await prisma.auditLog.upsert({
      where: { id: a.id },
      update: data,
      create: { id: a.id, ...data },
    });
  }
}

interface NoteSeed {
  bookingId: string;
  doctorId: string;
  notes: string;
  diagnosis: string | null;
  prescriptions: string | null;
  followUpInDays: number | null; // follow-up = today + N days (null = none)
}

// Consultation notes for the completed bookings, so the doctor↔patient loop has
// real records to show. Realistic Indian OP context. Keyed by bookingId (unique)
// so re-running upserts the same row — idempotent.
// Lazy: evaluated AFTER resolveDoctorIdentities() has assigned the doctor ids.
const NOTES = (): NoteSeed[] => [
  {
    bookingId: 'demo-bk-01', // Dr Smith (General Medicine) · Asha Rao
    doctorId: DR_SMITH,
    notes:
      'Fever 3 days, max 101°F, with body ache and mild dry cough. No breathlessness. Throat mildly congested, chest clear, SpO2 98%.',
    diagnosis: 'Acute viral fever with upper respiratory infection',
    prescriptions:
      'Tab Paracetamol 650mg TDS x 3 days; Tab Cetirizine 10mg HS x 3 days; steam inhalation; plenty of oral fluids and rest.',
    followUpInDays: 3,
  },
  {
    bookingId: 'demo-bk-06', // Dr Meera (Pediatrics) · Esha Gupta (age 6)
    doctorId: DR_MEERA,
    notes:
      'Child, 6y, loose stools 4-5 episodes/day x 1 day, no blood. Active, well hydrated. Advised ORS and continued feeding.',
    diagnosis: 'Acute gastroenteritis, mild dehydration',
    prescriptions:
      'ORS after each loose stool; Syrup Zinc 20mg OD x 14 days; Probiotic sachet OD x 5 days. Return if vomiting, blood in stool, or reduced urine.',
    followUpInDays: 2,
  },
  {
    bookingId: 'demo-bk-09', // Dr Sunita (Dermatology) · Lakshmi Iyer
    doctorId: DR_SUNITA,
    notes:
      'Itchy erythematous scaly patches over both forearms x 2 weeks. No oozing. Likely contact/atopic dermatitis.',
    diagnosis: 'Eczematous dermatitis',
    prescriptions:
      'Mometasone cream HS x 2 weeks; liberal moisturizer BD; avoid harsh soaps and hot water.',
    followUpInDays: null,
  },
];

async function seedNotes(): Promise<void> {
  for (const n of NOTES()) {
    const followUpDate =
      n.followUpInDays === null
        ? null
        : (() => {
            const d = today();
            d.setDate(d.getDate() + n.followUpInDays);
            return d;
          })();
    const data = {
      doctorId: n.doctorId,
      notes: n.notes,
      diagnosis: n.diagnosis,
      prescriptions: n.prescriptions,
      followUpDate,
    };
    await prisma.consultationNote.upsert({
      where: { bookingId: n.bookingId },
      update: data,
      create: { bookingId: n.bookingId, ...data },
    });
  }
}

/**
 * Remove rows from earlier seed versions that conflict with the current dataset
 * (a previous seed created doctors 0020/0021 + a Fortis clinic with usernames
 * this seed now reuses). No-op on a fresh database (e.g. the demo container).
 */
async function cleanupLegacy(): Promise<void> {
  const legacyDoctors = [
    '00000000-0000-0000-0000-000000000020',
    '00000000-0000-0000-0000-000000000021',
  ];
  const legacyClinic = '00000000-0000-0000-0000-000000000011';
  await prisma.booking.deleteMany({ where: { doctorId: { in: legacyDoctors } } });
  await prisma.queueSession.deleteMany({ where: { doctorId: { in: legacyDoctors } } });
  await prisma.auditLog.deleteMany({ where: { doctorId: { in: legacyDoctors } } });
  await prisma.doctor.deleteMany({ where: { id: { in: legacyDoctors } } });
  await prisma.clinic.deleteMany({ where: { id: legacyClinic } });
}

/**
 * Token-engine config per demo clinic (Task 5): two configurable TokenSeries
 * (Normal + Special), a clinic-default QueuePolicy, and a weekday SessionTemplate
 * per doctor. This is what lets the NEW pipeline (register → check-in → token →
 * enqueue) run for the demo data — without a series, token issuance has nothing
 * to allocate from. Idempotent (upsert by natural key / deterministic id).
 */
async function seedOpConfig(): Promise<void> {
  const opClinics = [CLINIC_A, CLINIC_C, CLINIC_B];
  for (const clinicId of opClinics) {
    await prisma.tokenSeries.upsert({
      where: { uq_series_code: { clinicId, code: 'NORMAL_OP' } },
      update: { label: 'Normal OP', prefix: 'N', padWidth: 3, startAt: 1, resetPolicy: TokenResetPolicy.PER_SESSION, active: true },
      create: { clinicId, code: 'NORMAL_OP', label: 'Normal OP', prefix: 'N', padWidth: 3, startAt: 1, resetPolicy: TokenResetPolicy.PER_SESSION },
    });
    await prisma.tokenSeries.upsert({
      where: { uq_series_code: { clinicId, code: 'SPECIAL_OP' } },
      update: { label: 'Special OP', prefix: 'S', padWidth: 3, startAt: 101, resetPolicy: TokenResetPolicy.PER_SESSION, active: true },
      create: { clinicId, code: 'SPECIAL_OP', label: 'Special OP', prefix: 'S', padWidth: 3, startAt: 101, resetPolicy: TokenResetPolicy.PER_SESSION },
    });

    // Clinic default policy (doctorId null): shared FIFO, interleave Special:Normal 2:1.
    const policyId = `demo-policy-${clinicId.slice(-4)}`;
    await prisma.queuePolicy.upsert({
      where: { id: policyId },
      update: { clinicId, doctorId: null, mode: QueuePolicyMode.SHARED_FIFO, ratio: { SPECIAL_OP: 2, NORMAL_OP: 1 } },
      create: { id: policyId, clinicId, doctorId: null, mode: QueuePolicyMode.SHARED_FIFO, ratio: { SPECIAL_OP: 2, NORMAL_OP: 1 } },
    });
  }

  // A weekday-morning session template per doctor (Mon–Sat).
  for (const d of DOCTORS()) {
    for (let day = 1; day <= 6; day++) {
      const id = `demo-tmpl-${d.id.slice(-4)}-${day}`;
      await prisma.sessionTemplate.upsert({
        where: { id },
        update: { doctorId: d.id, clinicId: d.clinicId, label: 'Morning OP', dayOfWeek: day, startTime: '09:00', endTime: '13:00', expectedLoad: 30, active: true },
        create: { id, doctorId: d.id, clinicId: d.clinicId, label: 'Morning OP', dayOfWeek: day, startTime: '09:00', endTime: '13:00', expectedLoad: 30 },
      });
    }
  }
}

async function main(): Promise<void> {
  // First statement in the script — before any read, write or delete.
  assertSafeToSeed();

  // Must run before any fixture array is evaluated: it decides whether this run
  // adopts the ids of doctors already in the database or uses freshly generated
  // ones. Every fixture array is a lazy function so it observes the result.
  await resolveDoctorIdentities();

  await cleanupLegacy();
  await seedHospitals();
  await seedClinics();
  await seedVoiceNumbers();
  await seedStaff();
  await seedDoctors();
  await seedSchedules();
  await seedPatients();
  await seedOpConfig();
  await seedBookings();
  await seedAudit();
  await seedNotes();

  console.log('Demo seed complete:');
  console.log('  Hospitals: City Health Network (City Care + Metro Care), Apollo Group (Apollo Hospitals)');
  console.log(`  Doctors : ${DOCTORS().length}`);
  console.log(`  Patients: ${PATIENTS.length}`);
  console.log('  OP config: TokenSeries (Normal+Special), QueuePolicy, SessionTemplate per demo clinic');
  console.log(`  Bookings: ${BOOKINGS().length} (completed / confirmed / expired)`);
  console.log(`  Notes   : ${NOTES().length} consultation notes on completed visits`);
  // Usernames only here. Any password generated for this run is printed by
  // reportGeneratedCredentials() below, which is explicitly a message to the
  // developer at their terminal — not something the application ever logs.
  console.log('  Logins  : City Health Network -> admin, superadmin, reception');
  console.log('            Apollo Group         -> admin2, reception2');
  console.log('            Doctors              -> drsmith (and others)');
  reportGeneratedCredentials();
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
