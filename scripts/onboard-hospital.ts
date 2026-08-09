/**
 * Onboard a NEW hospital (tenant) — the three things `/admin/*` cannot do for
 * you, in one idempotent command.
 *
 * Everything else about setting up a hospital is already an API/UI job (create
 * more clinics, doctors, schedules, staff — see the Admin tab in reception-app).
 * This script exists only for the bootstrap, which the HTTP surface cannot cover
 * by construction:
 *
 *   1. `Hospital` has no create endpoint at all.
 *   2. Its first ADMIN is a chicken-and-egg: every /admin route scopes to
 *      `tenantHospitalId(req)` read from the caller's token, so an admin inside
 *      the hospital must already exist before any of them can be called. Staff
 *      also require a `clinicId`, so the first clinic comes with it.
 *   3. `VoiceNumber` (DID -> clinic) has no admin endpoint either.
 *
 * The first clinic is created with the SAME OP config `AdminService.createClinic`
 * writes — NORMAL_OP/SPECIAL_OP `TokenSeries` + a clinic-default `QueuePolicy`.
 * Without those the clinic looks fine until the first patient, then token issue
 * fails ("could not raise a token"). Later clinics should be made through
 * `POST /admin/clinics`, which does the same thing.
 *
 * Usage:
 *   npx ts-node scripts/onboard-hospital.ts --hospital "Sunrise Health" \
 *     --clinic "Sunrise Main" [--address "..."] [--contact "+91..."] \
 *     [--admin-username sunrise-admin] [--admin-name "Site Admin"] \
 *     [--admin-password <plain>] [--reception-username sunrise-reception] \
 *     [--reception-password <plain>] [--did +918040001234] [--language en] \
 *     [--doctor "name=Dr Asha Rao,username=asha,fee=300"] [--doctor "..."]
 *
 * `--doctor` is repeatable and takes comma-separated key=value fields:
 *
 *   name           required
 *   specialization optional
 *   fee            consultation fee, default 0
 *   minutes        avgConsultMinutes — drives ETA, default 10
 *   username       enables doctor-app login (password generated if omitted)
 *   password       explicit login password
 *   start / end    "HH:MM" session window, default 09:00 / 13:00
 *   days           0=Sun … 6=Sat, as a range or pipe list: "0-6", "1-5", "1|3|5"
 *                  default 0-6
 *   load           expectedLoad on the weekly template (planning only), default 30
 *
 * Each doctor gets a `DoctorSession` (the legacy same-day resolver reads it —
 * without one, booking fails with "this doctor has no sessions today") and one
 * `SessionTemplate` per day (the public weekly-availability display). The new OP
 * engine needs neither: `OpSession` is get-or-create per doctor/day.
 *
 * Passwords are generated (CSPRNG, base64url) unless supplied, and printed ONCE
 * at the end — they are hashed with bcrypt cost 12 and never stored in plaintext.
 *
 * Idempotent: re-running with the same names/usernames updates in place rather
 * than duplicating. It never rewrites an existing account's password unless one
 * was passed explicitly.
 */
import {
  PrismaClient,
  QueuePolicyMode,
  StaffRole,
  TokenResetPolicy,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { DAILY_SESSION_TYPE } from '../src/common/session/daily-session';

const prisma = new PrismaClient();

const BCRYPT_ROUNDS = 12; // matches src/auth/password.service.ts

interface DoctorSpec {
  name: string;
  specialization?: string;
  fee: number;
  minutes: number;
  username?: string;
  password?: string;
  startTime: string;
  endTime: string;
  days: number[];
  expectedLoad: number;
}

interface Args {
  hospital: string;
  clinic: string;
  address?: string;
  contact?: string;
  adminUsername: string;
  adminName: string;
  adminPassword?: string;
  receptionUsername?: string;
  receptionName: string;
  receptionPassword?: string;
  did?: string;
  language?: string;
  doctors: DoctorSpec[];
}

/** "0-6" | "1|3|5" | "2" -> [0..6] | [1,3,5] | [2]; validated 0..6. */
function parseDays(spec: string): number[] {
  const range = /^(\d)\s*-\s*(\d)$/.exec(spec.trim());
  const values = range
    ? Array.from(
        { length: Number(range[2]) - Number(range[1]) + 1 },
        (_, i) => Number(range[1]) + i,
      )
    : spec.split('|').map((d) => Number(d.trim()));

  const days = [...new Set(values)].sort((a, b) => a - b);
  if (days.length === 0 || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new Error(`invalid days "${spec}" — use 0-6, 1-5 or 1|3|5 (0=Sunday)`);
  }
  return days;
}

/** "HH:MM", 24h. Rejected early rather than surfacing as a booking-time bug. */
function parseTime(value: string, field: string): string {
  const t = value.trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) {
    throw new Error(`invalid ${field} "${value}" — expected HH:MM (24h)`);
  }
  return t;
}

function parseNumber(value: string, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid ${field} "${value}"`);
  return n;
}

/** One `--doctor "name=…,fee=…"` value -> DoctorSpec. */
function parseDoctor(spec: string): DoctorSpec {
  const fields = new Map<string, string>();
  for (const part of spec.split(',')) {
    if (part.trim() === '') continue;
    const eq = part.indexOf('=');
    if (eq === -1) {
      throw new Error(`--doctor field "${part.trim()}" is not key=value`);
    }
    fields.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
  }

  const name = fields.get('name');
  if (!name) throw new Error(`--doctor "${spec}" has no name=`);

  const known = new Set([
    'name', 'specialization', 'fee', 'minutes', 'username',
    'password', 'start', 'end', 'days', 'load',
  ]);
  for (const key of fields.keys()) {
    // A typo like `feee=300` would otherwise silently create a free doctor.
    if (!known.has(key)) throw new Error(`--doctor: unknown field "${key}"`);
  }

  return {
    name,
    specialization: fields.get('specialization'),
    fee: fields.has('fee') ? parseNumber(fields.get('fee') as string, 'fee') : 0,
    minutes: fields.has('minutes')
      ? parseNumber(fields.get('minutes') as string, 'minutes')
      : 10,
    username: fields.get('username'),
    password: fields.get('password'),
    startTime: parseTime(fields.get('start') ?? '09:00', 'start'),
    endTime: parseTime(fields.get('end') ?? '13:00', 'end'),
    days: parseDays(fields.get('days') ?? '0-6'),
    expectedLoad: fields.has('load')
      ? parseNumber(fields.get('load') as string, 'load')
      : 30,
  };
}

/** Minimal `--flag value` parser — no dependency, no positional arguments. */
function parseArgs(argv: string[]): Args {
  const raw = new Map<string, string>();
  const doctorSpecs: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for ${key}`);
    }
    // --doctor is repeatable; every other flag is last-wins.
    if (key === '--doctor') doctorSpecs.push(value);
    else raw.set(key.slice(2), value);
    i += 1;
  }

  const hospital = raw.get('hospital');
  const clinic = raw.get('clinic');
  if (!hospital) throw new Error('--hospital is required');
  if (!clinic) throw new Error('--clinic is required');

  const slug = hospital
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);

  return {
    hospital,
    clinic,
    address: raw.get('address'),
    contact: raw.get('contact'),
    adminUsername: raw.get('admin-username') ?? `${slug}-admin`,
    adminName: raw.get('admin-name') ?? `${hospital} Admin`,
    adminPassword: raw.get('admin-password'),
    receptionUsername: raw.get('reception-username') ?? `${slug}-reception`,
    receptionName: raw.get('reception-name') ?? `${hospital} Reception`,
    receptionPassword: raw.get('reception-password'),
    did: raw.get('did'),
    language: raw.get('language') ?? 'en',
    doctors: doctorSpecs.map(parseDoctor),
  };
}

const generated: { account: string; password: string }[] = [];

function passwordFor(account: string, supplied?: string): string {
  if (supplied && supplied.length > 0) return supplied;
  const password = randomBytes(24).toString('base64url');
  generated.push({ account, password });
  return password;
}

/**
 * Create the staff account, or leave an existing one alone. A re-run must not
 * silently rotate a password the hospital is already using — only an explicit
 * --*-password does that.
 */
async function upsertStaff(params: {
  username: string;
  name: string;
  role: StaffRole;
  hospitalId: string;
  clinicId: string;
  suppliedPassword?: string;
  accountLabel: string;
}): Promise<{ created: boolean }> {
  const existing = await prisma.staff.findUnique({
    where: { username: params.username },
    select: { id: true },
  });

  if (existing) {
    const data: {
      name: string;
      role: StaffRole;
      hospitalId: string;
      clinicId: string;
      loginCredentials?: string;
    } = {
      name: params.name,
      role: params.role,
      hospitalId: params.hospitalId,
      clinicId: params.clinicId,
    };
    if (params.suppliedPassword) {
      data.loginCredentials = await bcrypt.hash(
        params.suppliedPassword,
        BCRYPT_ROUNDS,
      );
    }
    await prisma.staff.update({ where: { id: existing.id }, data });
    return { created: false };
  }

  const plain = passwordFor(params.accountLabel, params.suppliedPassword);
  await prisma.staff.create({
    data: {
      hospitalId: params.hospitalId,
      clinicId: params.clinicId,
      name: params.name,
      role: params.role,
      username: params.username,
      loginCredentials: await bcrypt.hash(plain, BCRYPT_ROUNDS),
    },
  });
  return { created: true };
}

interface DoctorOutcome {
  name: string;
  created: boolean;
  username?: string;
  sessionDays: number[] | null; // null = already had a schedule, left alone
}

/**
 * Create the doctor, their same-day session and their weekly templates.
 *
 * The session is the part that is easy to forget and impossible to notice until
 * a patient tries to book: `PaymentsService.initiateBooking` resolves TODAY's
 * session and throws `409 this doctor has no sessions today` when there is none.
 *
 * Idempotent per piece: an existing doctor is updated, an existing schedule is
 * left completely alone (overwriting it could silently change a live clinic's
 * hours), and templates are filled in per missing day.
 */
async function provisionDoctor(
  clinicId: string,
  spec: DoctorSpec,
): Promise<DoctorOutcome> {
  const existing = spec.username
    ? await prisma.doctor.findUnique({
        where: { username: spec.username },
        select: { id: true, clinicId: true },
      })
    : await prisma.doctor.findFirst({
        where: { clinicId, name: spec.name },
        select: { id: true, clinicId: true },
      });

  if (existing && existing.clinicId !== clinicId) {
    throw new Error(
      `doctor username "${spec.username}" already exists in another clinic`,
    );
  }

  const label = `${spec.username ?? spec.name} (DOCTOR)`;
  const wantsLogin = Boolean(spec.username);

  let doctorId: string;
  let created: boolean;
  if (existing) {
    doctorId = existing.id;
    created = false;
    await prisma.doctor.update({
      where: { id: existing.id },
      data: {
        name: spec.name,
        specialization: spec.specialization ?? null,
        consultationFee: spec.fee,
        avgConsultMinutes: spec.minutes,
        // As with staff: never rotate an existing password implicitly.
        ...(spec.password
          ? { passwordHash: await bcrypt.hash(spec.password, BCRYPT_ROUNDS) }
          : {}),
      },
    });
  } else {
    const plain = wantsLogin ? passwordFor(label, spec.password) : null;
    const row = await prisma.doctor.create({
      data: {
        clinicId,
        name: spec.name,
        specialization: spec.specialization ?? null,
        consultationFee: spec.fee,
        avgConsultMinutes: spec.minutes,
        username: spec.username ?? null,
        passwordHash: plain ? await bcrypt.hash(plain, BCRYPT_ROUNDS) : null,
      },
      select: { id: true },
    });
    doctorId = row.id;
    created = true;
  }

  // ── same-day session (legacy resolver) ──
  const hasSession = await prisma.doctorSession.count({ where: { doctorId } });
  let sessionDays: number[] | null = null;
  if (hasSession === 0) {
    await prisma.doctorSession.create({
      data: {
        doctorId,
        // Pinned constant, never a time of day — see common/session/daily-session.
        sessionType: DAILY_SESSION_TYPE,
        startTime: spec.startTime,
        maxTokens: spec.expectedLoad,
        daysOfWeek: spec.days,
      },
    });
    sessionDays = spec.days;
  }

  // ── weekly templates (public availability display) ──
  for (const day of spec.days) {
    const template = await prisma.sessionTemplate.findFirst({
      where: { doctorId, dayOfWeek: day },
      select: { id: true },
    });
    if (template) continue;
    await prisma.sessionTemplate.create({
      data: {
        doctorId,
        clinicId,
        label: 'OP',
        dayOfWeek: day,
        startTime: spec.startTime,
        endTime: spec.endTime,
        expectedLoad: spec.expectedLoad,
      },
    });
  }

  return { name: spec.name, created, username: spec.username, sessionDays };
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // ── 1. Hospital (tenant) ──
  const existingHospital = await prisma.hospital.findFirst({
    where: { name: args.hospital },
    select: { id: true },
  });
  const hospital =
    existingHospital ??
    (await prisma.hospital.create({
      data: { name: args.hospital },
      select: { id: true },
    }));

  // ── 2. First clinic + the OP config it cannot function without ──
  // One transaction, exactly like AdminService.createClinic: a clinic that
  // exists without its token series is the half-configured state to avoid.
  const existingClinic = await prisma.clinic.findFirst({
    where: { hospitalId: hospital.id, name: args.clinic },
    select: { id: true },
  });

  const clinic =
    existingClinic ??
    (await prisma.$transaction(async (tx) => {
      const created = await tx.clinic.create({
        data: {
          hospitalId: hospital.id,
          name: args.clinic,
          address: args.address ?? null,
          contactNumber: args.contact ?? null,
        },
        select: { id: true },
      });
      await tx.tokenSeries.createMany({
        data: [
          {
            clinicId: created.id,
            code: 'NORMAL_OP',
            label: 'Normal OP',
            prefix: 'N',
            padWidth: 3,
            startAt: 1,
            resetPolicy: TokenResetPolicy.PER_SESSION,
          },
          {
            clinicId: created.id,
            code: 'SPECIAL_OP',
            label: 'Special OP',
            prefix: 'S',
            padWidth: 3,
            startAt: 101,
            resetPolicy: TokenResetPolicy.PER_SESSION,
          },
        ],
      });
      await tx.queuePolicy.create({
        data: {
          clinicId: created.id,
          doctorId: null,
          mode: QueuePolicyMode.SHARED_FIFO,
          ratio: { SPECIAL_OP: 2, NORMAL_OP: 1 },
        },
      });
      return created;
    }));

  // A pre-existing clinic may predate this script (or the config-provisioning
  // fix), so make sure the series/policy are there either way.
  const seriesCount = await prisma.tokenSeries.count({
    where: { clinicId: clinic.id },
  });
  if (seriesCount === 0) {
    await prisma.tokenSeries.createMany({
      data: [
        {
          clinicId: clinic.id,
          code: 'NORMAL_OP',
          label: 'Normal OP',
          prefix: 'N',
          padWidth: 3,
          startAt: 1,
          resetPolicy: TokenResetPolicy.PER_SESSION,
        },
        {
          clinicId: clinic.id,
          code: 'SPECIAL_OP',
          label: 'Special OP',
          prefix: 'S',
          padWidth: 3,
          startAt: 101,
          resetPolicy: TokenResetPolicy.PER_SESSION,
        },
      ],
    });
  }
  const policyCount = await prisma.queuePolicy.count({
    where: { clinicId: clinic.id, doctorId: null },
  });
  if (policyCount === 0) {
    await prisma.queuePolicy.create({
      data: {
        clinicId: clinic.id,
        doctorId: null,
        mode: QueuePolicyMode.SHARED_FIFO,
        ratio: { SPECIAL_OP: 2, NORMAL_OP: 1 },
      },
    });
  }

  // ── 3. First ADMIN (the account that unlocks every /admin route) ──
  const admin = await upsertStaff({
    username: args.adminUsername,
    name: args.adminName,
    role: StaffRole.ADMIN,
    hospitalId: hospital.id,
    clinicId: clinic.id,
    suppliedPassword: args.adminPassword,
    accountLabel: `${args.adminUsername} (ADMIN)`,
  });

  // ── 4. Optional front-desk account ──
  let reception: { created: boolean } | null = null;
  if (args.receptionUsername) {
    reception = await upsertStaff({
      username: args.receptionUsername,
      name: args.receptionName,
      role: StaffRole.RECEPTIONIST,
      hospitalId: hospital.id,
      clinicId: clinic.id,
      suppliedPassword: args.receptionPassword,
      accountLabel: `${args.receptionUsername} (RECEPTIONIST)`,
    });
  }

  // ── 5. Optional doctors, each with a schedule ──
  const doctors: DoctorOutcome[] = [];
  for (const spec of args.doctors) {
    doctors.push(await provisionDoctor(clinic.id, spec));
  }

  // ── 6. Optional voice DID -> clinic mapping ──
  if (args.did) {
    await prisma.voiceNumber.upsert({
      where: { didNumber: args.did },
      update: { clinicId: clinic.id, language: args.language ?? null },
      create: {
        didNumber: args.did,
        clinicId: clinic.id,
        language: args.language ?? null,
      },
    });
  }

  /* eslint-disable no-console */
  console.log('');
  console.log('Hospital onboarded:');
  console.log(`  Hospital : ${args.hospital}  (${hospital.id})`);
  console.log(
    `  Clinic   : ${args.clinic}  (${clinic.id})${existingClinic ? ' [existing]' : ''}`,
  );
  console.log('  OP config: NORMAL_OP (N-001…) + SPECIAL_OP (S-101…), SHARED_FIFO policy');
  console.log(
    `  Admin    : ${args.adminUsername}${admin.created ? '' : ' [existing, unchanged]'}`,
  );
  if (reception) {
    console.log(
      `  Reception: ${args.receptionUsername}${reception.created ? '' : ' [existing, unchanged]'}`,
    );
  }
  if (args.did) console.log(`  Voice DID: ${args.did} -> this clinic`);

  for (const d of doctors) {
    const schedule =
      d.sessionDays === null
        ? 'schedule already set, left unchanged'
        : `session ${d.sessionDays.map((x) => DAY_NAMES[x]).join('/')}`;
    console.log(
      `  Doctor   : ${d.name}${d.username ? ` [${d.username}]` : ' [no login]'}` +
        `${d.created ? '' : ' [existing]'} — ${schedule}`,
    );
  }

  if (generated.length > 0) {
    console.log('');
    console.log('  ── GENERATED PASSWORDS (shown once, not stored) ──');
    for (const g of generated) console.log(`    ${g.account.padEnd(34)} ${g.password}`);
    console.log('  Hand these over, then change them from the Admin tab.');
  }

  console.log('');
  console.log('Next, signed in as the admin above (reception-app -> Admin tab):');
  if (doctors.length === 0) {
    console.log('  - POST /admin/doctors            — add doctors (+ username/password for doctor-app)');
    console.log('  - POST /admin/doctors/:id/sessions — REQUIRED: no session today = booking 409s');
  } else {
    console.log('  - POST /admin/doctors            — any further doctors (schedule them too)');
  }
  console.log('  - POST /admin/clinics            — any further clinics in this hospital');
  console.log('  - PUT  /op/config                — reads.cutover.* flags, per clinic (default off)');
  console.log('');
  /* eslint-enable no-console */
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
