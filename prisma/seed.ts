/**
 * Demo seed for Patient Flow OS.
 *
 * Populates a realistic, demo-ready dataset: 2 clinics, 5 doctors across
 * specialties (morning + evening sessions each), 12 patients, and a spread of
 * bookings (completed / confirmed / expired) plus matching payments and audit
 * entries so booking history and the audit log are never empty.
 *
 * Login credentials are documented in DEMO.md. Idempotent: every row is upserted
 * by a stable id (patients by their unique mobile), so re-running — which the
 * container does on every start — never creates duplicates.
 */
import {
  PrismaClient,
  StaffRole,
  Gender,
  BookingSource,
  BookingStatus,
  PaymentStatus,
  SessionType,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// ── Stable ids (text columns). The first three are referenced by the apps,
// tests and emulator session — keep them EXACTLY as-is. ───────────────────────

// Hospitals (tenants). HOSPITAL_A's id MUST match the migration backfill id so a
// fresh migrate+seed keeps Clinic A under the same tenant.
const HOSPITAL_A = '00000000-0000-0000-0000-0000000000a1'; // City Health Network
const HOSPITAL_B = '00000000-0000-0000-0000-0000000000b1'; // Apollo Group

const CLINIC_A = '00000000-0000-0000-0000-000000000001'; // City Care Clinic    @ HOSPITAL_A
const CLINIC_C = '00000000-0000-0000-0000-000000000013'; // Metro Care Clinic   @ HOSPITAL_A (2nd clinic -> exercises ADMIN multi-clinic scope)
const STAFF_RECEPTION = '00000000-0000-0000-0000-000000000002';
const DR_SMITH = '00000000-0000-0000-0000-000000000003';

const CLINIC_B = '00000000-0000-0000-0000-000000000010'; // Apollo Hospitals    @ HOSPITAL_B
const STAFF_ADMIN = '00000000-0000-0000-0000-000000000008';
const SUPER_ADMIN = '00000000-0000-0000-0000-000000000009'; // super-admin (HOSPITAL_A)
const STAFF_ADMIN_B = '00000000-0000-0000-0000-000000000014'; // admin for HOSPITAL_B
const STAFF_RECEPTION_B = '00000000-0000-0000-0000-000000000012';

const DR_MEERA = '00000000-0000-0000-0000-000000000004'; // Pediatrics   @ CLINIC_A / HOSPITAL_A
const DR_ARJUN = '00000000-0000-0000-0000-000000000005'; // ENT          @ CLINIC_A / HOSPITAL_A
const DR_KAVYA = '00000000-0000-0000-0000-000000000006'; // Orthopedics  @ CLINIC_B / HOSPITAL_B
const DR_SUNITA = '00000000-0000-0000-0000-000000000007'; // Dermatology  @ CLINIC_B / HOSPITAL_B
// Overlapping shape on purpose: HOSPITAL_A also has a Dermatologist with a
// near-identical name, in its 2nd clinic — so any cross-tenant leak is obvious.
const DR_SUNITA_A = '00000000-0000-0000-0000-000000000015'; // Dermatology @ CLINIC_C / HOSPITAL_A

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

async function seedStaff(): Promise<void> {
  const receptionHash = await bcrypt.hash('reception123', 12);
  const adminHash = await bcrypt.hash('admin123', 12);
  const superHash = await bcrypt.hash('superadmin123', 12);

  await prisma.staff.upsert({
    where: { id: STAFF_RECEPTION },
    update: { loginCredentials: receptionHash, username: 'reception', hospitalId: HOSPITAL_A, clinicId: CLINIC_A },
    create: {
      id: STAFF_RECEPTION,
      hospitalId: HOSPITAL_A,
      clinicId: CLINIC_A,
      name: 'Front Desk',
      role: StaffRole.RECEPTIONIST,
      username: 'reception',
      loginCredentials: receptionHash,
    },
  });
  await prisma.staff.upsert({
    where: { id: STAFF_RECEPTION_B },
    update: { loginCredentials: receptionHash, username: 'reception2', hospitalId: HOSPITAL_B, clinicId: CLINIC_B },
    create: {
      id: STAFF_RECEPTION_B,
      hospitalId: HOSPITAL_B,
      clinicId: CLINIC_B,
      name: 'Apollo Front Desk',
      role: StaffRole.RECEPTIONIST,
      username: 'reception2',
      loginCredentials: receptionHash,
    },
  });
  await prisma.staff.upsert({
    where: { id: STAFF_ADMIN },
    update: { loginCredentials: adminHash, username: 'admin', hospitalId: HOSPITAL_A, clinicId: CLINIC_A },
    create: {
      id: STAFF_ADMIN,
      hospitalId: HOSPITAL_A,
      clinicId: CLINIC_A,
      name: 'Clinic Admin',
      role: StaffRole.ADMIN,
      username: 'admin',
      loginCredentials: adminHash,
    },
  });
  // ADMIN for HOSPITAL_B — so the demo has an admin per hospital and cross-tenant
  // isolation is exercisable by logging into each.
  await prisma.staff.upsert({
    where: { id: STAFF_ADMIN_B },
    update: { loginCredentials: adminHash, username: 'admin2', hospitalId: HOSPITAL_B, clinicId: CLINIC_B },
    create: {
      id: STAFF_ADMIN_B,
      hospitalId: HOSPITAL_B,
      clinicId: CLINIC_B,
      name: 'Apollo Admin',
      role: StaffRole.ADMIN,
      username: 'admin2',
      loginCredentials: adminHash,
    },
  });
  // Super-admin: ADMIN account (HOSPITAL_A) used for the admin dashboard.
  // Credentials documented in DEMO.md.
  await prisma.staff.upsert({
    where: { id: SUPER_ADMIN },
    update: { loginCredentials: superHash, username: 'superadmin', hospitalId: HOSPITAL_A, clinicId: CLINIC_A },
    create: {
      id: SUPER_ADMIN,
      hospitalId: HOSPITAL_A,
      clinicId: CLINIC_A,
      name: 'Super Admin',
      role: StaffRole.ADMIN,
      username: 'superadmin',
      loginCredentials: superHash,
    },
  });
}

// Recurring weekly schedule templates (DoctorSession).
//
// Same-day model: the patient app's "Join Queue" auto-resolves TODAY's session,
// so every demo doctor gets at least one session that runs EVERY day of the week
// (daysOfWeek 0..6). That way the demo's same-day queue works no matter which
// day the seed is run/demoed on — no "no sessions today" dead end on a weekend.
// maxTokens is retained but is now informational ("expected load"), NOT a cap.
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
async function seedSchedules(): Promise<void> {
  const rows = [
    { id: 'demo-sess-smith-am', doctorId: DR_SMITH, sessionType: SessionType.MORNING, startTime: '09:00', maxTokens: 20, daysOfWeek: EVERY_DAY },
    { id: 'demo-sess-smith-pm', doctorId: DR_SMITH, sessionType: SessionType.EVENING, startTime: '17:00', maxTokens: 15, daysOfWeek: [1, 3, 5] },
    { id: 'demo-sess-meera-am', doctorId: DR_MEERA, sessionType: SessionType.MORNING, startTime: '10:00', maxTokens: 18, daysOfWeek: EVERY_DAY },
    { id: 'demo-sess-arjun-am', doctorId: DR_ARJUN, sessionType: SessionType.MORNING, startTime: '11:00', maxTokens: 16, daysOfWeek: EVERY_DAY },
    { id: 'demo-sess-kavya-pm', doctorId: DR_KAVYA, sessionType: SessionType.EVENING, startTime: '16:30', maxTokens: 12, daysOfWeek: EVERY_DAY },
    { id: 'demo-sess-sunita-am', doctorId: DR_SUNITA, sessionType: SessionType.MORNING, startTime: '09:30', maxTokens: 14, daysOfWeek: EVERY_DAY },
    { id: 'demo-sess-sunita-a-am', doctorId: DR_SUNITA_A, sessionType: SessionType.MORNING, startTime: '10:30', maxTokens: 14, daysOfWeek: EVERY_DAY },
  ];
  for (const r of rows) {
    const { id, ...data } = r;
    await prisma.doctorSession.upsert({ where: { id }, update: data, create: { id, ...data } });
  }
}

// Inbound telephony DIDs → clinic, so the voice agent routes a call to the right
// tenant. One demo number per clinic.
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

const DOCTORS: DoctorSeed[] = [
  { id: DR_SMITH, clinicId: CLINIC_A, name: 'Dr. Anil Smith', specialization: 'General Medicine', fee: 500, avg: 10, username: 'drsmith' },
  { id: DR_MEERA, clinicId: CLINIC_A, name: 'Dr. Meera Nair', specialization: 'Pediatrics', fee: 400, avg: 12, username: 'meera.nair' },
  { id: DR_ARJUN, clinicId: CLINIC_A, name: 'Dr. Arjun Rao', specialization: 'ENT', fee: 350, avg: 8, username: 'arjun.rao' },
  { id: DR_KAVYA, clinicId: CLINIC_B, name: 'Dr. Kavya Pillai', specialization: 'Orthopedics', fee: 700, avg: 15, username: 'kavya.pillai' },
  { id: DR_SUNITA, clinicId: CLINIC_B, name: 'Dr. Sunita Verma', specialization: 'Dermatology', fee: 600, avg: 10, username: 'sunita.verma' },
  // HOSPITAL_A, 2nd clinic — deliberately a Dermatologist named like CLINIC_B's
  // Dr. Sunita Verma, so a cross-tenant leak (mixing the two) is easy to spot.
  { id: DR_SUNITA_A, clinicId: CLINIC_C, name: 'Dr. Sunita Sharma', specialization: 'Dermatology', fee: 550, avg: 10, username: 'sunita.sharma' },
];

async function seedDoctors(): Promise<void> {
  // every doctor shares the demo password 'doctor123' (documented in DEMO.md)
  const hash = await bcrypt.hash('doctor123', 12);
  for (const d of DOCTORS) {
    await prisma.doctor.upsert({
      where: { id: d.id },
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

    // morning + evening session record for today (durable session metadata;
    // the live ordering itself lives in Redis and is built during the demo)
    for (const sessionType of [SessionType.MORNING, SessionType.EVENING]) {
      await prisma.queueSession.upsert({
        where: { uq_session: { doctorId: d.id, sessionDate: today(), sessionType } },
        update: {},
        create: { doctorId: d.id, sessionDate: today(), sessionType, isOpen: true },
      });
    }
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
const BOOKINGS: BookingSeed[] = [
  // Dr Smith — two seen today, two waiting
  { id: 'demo-bk-01', patientId: 'demo-pt-01', doctorId: DR_SMITH, sessionType: SessionType.MORNING, status: BookingStatus.COMPLETED, token: 'A001', fee: 500, payment: PaymentStatus.SUCCESS, paymentId: 'demo-pay-01', completed: true, dayOffset: 0, waitMinutes: 45, consultMinutes: 12 },
  { id: 'demo-bk-02', patientId: 'demo-pt-02', doctorId: DR_SMITH, sessionType: SessionType.MORNING, status: BookingStatus.COMPLETED, token: 'A002', fee: 500, payment: PaymentStatus.SUCCESS, paymentId: 'demo-pay-02', completed: true, dayOffset: 0, waitMinutes: 30, consultMinutes: 10 },
  { id: 'demo-bk-03', patientId: 'demo-pt-03', doctorId: DR_SMITH, sessionType: SessionType.MORNING, status: BookingStatus.BOOKED, token: 'A003', fee: 500, payment: PaymentStatus.SUCCESS, paymentId: 'demo-pay-03' },
  { id: 'demo-bk-04', patientId: 'demo-pt-04', doctorId: DR_SMITH, sessionType: SessionType.MORNING, status: BookingStatus.BOOKED, token: 'A004', fee: 500, payment: PaymentStatus.SUCCESS, paymentId: 'demo-pay-04' },
  // Dr Smith — a failed/expired payment (never got a token)
  { id: 'demo-bk-05', patientId: 'demo-pt-06', doctorId: DR_SMITH, sessionType: SessionType.MORNING, status: BookingStatus.EXPIRED, token: null, fee: 500, payment: PaymentStatus.FAILED, paymentId: 'demo-pay-05' },
  // Dr Meera (pediatrics) — seen yesterday, one waiting today
  { id: 'demo-bk-06', patientId: 'demo-pt-05', doctorId: DR_MEERA, sessionType: SessionType.MORNING, status: BookingStatus.COMPLETED, token: 'A001', fee: 400, payment: PaymentStatus.SUCCESS, paymentId: 'demo-pay-06', completed: true, dayOffset: 1, waitMinutes: 60, consultMinutes: 15 },
  { id: 'demo-bk-07', patientId: 'demo-pt-11', doctorId: DR_MEERA, sessionType: SessionType.MORNING, status: BookingStatus.BOOKED, token: 'A002', fee: 400, payment: PaymentStatus.SUCCESS, paymentId: 'demo-pay-07' },
  // Dr Kavya (ortho, clinic B) — evening, one waiting
  { id: 'demo-bk-08', patientId: 'demo-pt-08', doctorId: DR_KAVYA, sessionType: SessionType.EVENING, status: BookingStatus.BOOKED, token: 'A001', fee: 700, payment: PaymentStatus.SUCCESS, paymentId: 'demo-pay-08' },
  // Dr Sunita (derma, clinic B) — seen two days ago
  { id: 'demo-bk-09', patientId: 'demo-pt-12', doctorId: DR_SUNITA, sessionType: SessionType.MORNING, status: BookingStatus.COMPLETED, token: 'A001', fee: 600, payment: PaymentStatus.SUCCESS, paymentId: 'demo-pay-09', completed: true, dayOffset: 2, waitMinutes: 75, consultMinutes: 20 },
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

  // The seed owns the demo doctors' sessions. Clear any existing bookings for
  // them (across the dated window the demo uses) first so the fixed demo tokens
  // never collide with rows left over from a prior demo / live run (unique:
  // doctor+date+session+token). Idempotent: rows below are re-created by id.
  const windowStart = startOfLocalDay(new Date(Date.now() - 7 * DAY_MS));
  await prisma.booking.deleteMany({
    where: {
      doctorId: { in: DOCTORS.map((doc) => doc.id) },
      sessionDate: { gte: windowStart },
    },
  });

  // Live (not-completed) bookings sit in today's session; give them a createdAt
  // a little while ago so "today" is populated without inventing a consult.
  const liveCreatedAt = new Date(Date.now() - 25 * 60_000);

  for (const b of BOOKINGS) {
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
const AUDIT: AuditSeed[] = [
  { id: 'demo-audit-01', doctorId: DR_SMITH, clinicId: CLINIC_A, action: 'DONE', token: 'A001', bookingId: 'demo-bk-01', sessionType: SessionType.MORNING },
  { id: 'demo-audit-02', doctorId: DR_SMITH, clinicId: CLINIC_A, action: 'DONE', token: 'A002', bookingId: 'demo-bk-02', sessionType: SessionType.MORNING },
  { id: 'demo-audit-03', doctorId: DR_SMITH, clinicId: CLINIC_A, action: 'SKIP', token: 'A003', bookingId: 'demo-bk-03', sessionType: SessionType.MORNING },
  { id: 'demo-audit-04', doctorId: DR_MEERA, clinicId: CLINIC_A, action: 'DONE', token: 'A001', bookingId: 'demo-bk-06', sessionType: SessionType.MORNING },
  { id: 'demo-audit-05', doctorId: DR_SUNITA, clinicId: CLINIC_B, action: 'DONE', token: 'A001', bookingId: 'demo-bk-09', sessionType: SessionType.MORNING },
];

async function seedAudit(): Promise<void> {
  for (const a of AUDIT) {
    // Match the audit row's date to the booking's actual session day (completed
    // visits may be on past days), falling back to today for any unmapped id.
    const sessionDate = bookingSessionDate.get(a.bookingId) ?? today();
    const data = {
      actorId: STAFF_RECEPTION, // recorded against the desk operator
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
const NOTES: NoteSeed[] = [
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
  for (const n of NOTES) {
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

async function main(): Promise<void> {
  await cleanupLegacy();
  await seedHospitals();
  await seedClinics();
  await seedVoiceNumbers();
  await seedStaff();
  await seedDoctors();
  await seedSchedules();
  await seedPatients();
  await seedBookings();
  await seedAudit();
  await seedNotes();

  console.log('Demo seed complete:');
  console.log('  Hospitals: City Health Network (City Care + Metro Care), Apollo Group (Apollo Hospitals)');
  console.log(`  Doctors : ${DOCTORS.length} (all password: doctor123)`);
  console.log(`  Patients: ${PATIENTS.length}`);
  console.log(`  Bookings: ${BOOKINGS.length} (completed / confirmed / expired)`);
  console.log(`  Notes   : ${NOTES.length} consultation notes on completed visits`);
  console.log('  Logins  : City Health Network -> admin/admin123, superadmin/superadmin123, reception/reception123');
  console.log('            Apollo Group         -> admin2/admin123, reception2/reception123');
  console.log('            doctors -> drsmith/doctor123 (and others, all doctor123)');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
