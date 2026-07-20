/**
 * Public projection DTOs for discovery. These mappers build a FRESH object with
 * an explicit field allow-list — they never spread the input. Internal/auth
 * fields (password_hash, username, …) are structurally unreachable: even if a
 * raw Prisma model (hash included) is passed in, only the whitelisted keys are
 * read, so they cannot serialize into a response.
 */

export interface PublicClinic {
  id: string;
  name: string;
  address: string | null;
  contactNumber: string | null;
}

export interface PublicDoctor {
  id: string;
  name: string;
  specialization: string | null;
  consultationFee: number;
  photoUrl: string | null;
  clinicId: string;
  clinic?: PublicClinic;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

// ─── Doctor schedule (public availability) ───

/** One recurring weekly session template (the doctor's standing schedule). */
export interface PublicSessionTemplate {
  sessionType: string; // MORNING | EVENING
  startTime: string; // "HH:MM"
  maxTokens: number;
  daysOfWeek: number[]; // 0=Sun … 6=Sat
}

/** A concrete bookable session on a specific upcoming date, with live capacity. */
export interface PublicUpcomingSession {
  date: string; // YYYY-MM-DD
  dayOfWeek: number; // 0=Sun … 6=Sat
  sessionType: string; // MORNING | EVENING
  startTime: string; // "HH:MM"
  maxTokens: number;
  tokensIssued: number; // tokens already issued for this date+session
  available: boolean; // tokensIssued < maxTokens
}

export interface PublicDoctorSchedule {
  doctorId: string;
  name: string;
  specialization: string | null;
  consultationFee: number;
  photoUrl: string | null;
  clinic?: PublicClinic;
  weekly: PublicSessionTemplate[]; // standing weekly schedule
  upcoming: PublicUpcomingSession[]; // next 7 days, only days the doctor sits
}

// ─── Same-day "Join Queue" state ───

/** Today's joinable session (time window + fee). No capacity cap, so there is
 *  no "full" state — only available / not-scheduled-today / all-ended. */
export interface PublicTodaySession {
  available: boolean;
  reason?: 'NOT_SCHEDULED' | 'ENDED'; // present only when available === false
  session?: {
    sessionType: string; // MORNING | EVENING
    sessionDate: string; // YYYY-MM-DD (today)
    startTime: string; // "HH:MM"
    endTime: string; // inferred "HH:MM" ('24:00' = end-of-day)
    fee: number;
  };
}

// Loose input types: callers may hand us a full model — we read only safe keys.
type ClinicLike = {
  id: string;
  name: string;
  address?: string | null;
  contactNumber?: string | null;
};
type DoctorLike = {
  id: string;
  name: string;
  specialization?: string | null;
  consultationFee: number;
  photoUrl?: string | null;
  clinicId: string;
  clinic?: ClinicLike | null;
};

type SessionTemplateLike = {
  sessionType: string;
  startTime: string;
  maxTokens: number;
  daysOfWeek: number[];
};

export function toPublicClinic(c: ClinicLike): PublicClinic {
  return {
    id: c.id,
    name: c.name,
    address: c.address ?? null,
    contactNumber: c.contactNumber ?? null,
  };
}

export function toPublicDoctor(d: DoctorLike): PublicDoctor {
  const out: PublicDoctor = {
    id: d.id,
    name: d.name,
    specialization: d.specialization ?? null,
    consultationFee: d.consultationFee,
    photoUrl: d.photoUrl ?? null,
    clinicId: d.clinicId,
  };
  if (d.clinic) out.clinic = toPublicClinic(d.clinic);
  return out;
}

export function toPublicSessionTemplate(s: SessionTemplateLike): PublicSessionTemplate {
  return {
    sessionType: s.sessionType,
    startTime: s.startTime,
    maxTokens: s.maxTokens,
    daysOfWeek: [...s.daysOfWeek].sort((a, b) => a - b),
  };
}

export function toPublicDoctorSchedule(
  d: DoctorLike,
  weekly: PublicSessionTemplate[],
  upcoming: PublicUpcomingSession[],
): PublicDoctorSchedule {
  const out: PublicDoctorSchedule = {
    doctorId: d.id,
    name: d.name,
    specialization: d.specialization ?? null,
    consultationFee: d.consultationFee,
    photoUrl: d.photoUrl ?? null,
    weekly,
    upcoming,
  };
  if (d.clinic) out.clinic = toPublicClinic(d.clinic);
  return out;
}
