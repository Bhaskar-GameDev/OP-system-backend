import { SessionType, StaffRole } from '@prisma/client';

/**
 * Admin-portal projection DTOs. Like Discovery, every mapper builds a FRESH
 * object with an explicit allow-list and never spreads the input — so secret
 * auth material (doctor.passwordHash, staff.loginCredentials) is structurally
 * unreachable in any admin response, even if a raw model is handed in.
 *
 * `username` IS surfaced here (unlike Discovery): the admin manages these
 * accounts, so the login handle is theirs to see. The password HASH never is.
 */

export interface AdminClinicView {
  id: string;
  name: string;
  address: string | null;
  contactNumber: string | null;
}

export interface AdminDoctorView {
  id: string;
  clinicId: string;
  name: string;
  specialization: string | null;
  consultationFee: number;
  avgConsultMinutes: number;
  photoUrl: string | null;
  username: string | null;
  /**
   * Whether this doctor can actually sign into the doctor app — they need BOTH
   * a username and a password on file (`doctorLogin` rejects a null hash).
   * Credentials are optional at creation, so it is entirely possible to create a
   * doctor who is bookable by patients but can never open their own queue. The
   * admin screen has no other way to see that, so it is surfaced here.
   * The hash itself is never returned.
   */
  canSignIn: boolean;
  /**
   * How many weekly session templates the doctor has. Zero means they are
   * listed to patients but not bookable — `resolveToday` finds no open session
   * and booking 409s "this doctor has no sessions today". Surfaced so the admin
   * screen can flag a half-configured doctor instead of leaving it to be
   * discovered by a patient.
   */
  sessionCount: number;
}

export interface AdminDoctorSessionView {
  id: string;
  doctorId: string;
  sessionType: SessionType;
  startTime: string; // "HH:MM"
  maxTokens: number;
  daysOfWeek: number[]; // 0=Sun … 6=Sat
}

export interface AdminStaffView {
  id: string;
  clinicId: string;
  name: string;
  role: StaffRole;
  username: string | null;
}

// ─── Loose input types (a full model may be passed; only safe keys read) ───

type ClinicLike = {
  id: string;
  name: string;
  address?: string | null;
  contactNumber?: string | null;
};
type DoctorLike = {
  id: string;
  clinicId: string;
  name: string;
  specialization?: string | null;
  consultationFee: number;
  avgConsultMinutes: number;
  photoUrl?: string | null;
  username?: string | null;
  /** Presence only — the hash is used to derive `canSignIn`, never returned. */
  passwordHash?: string | null;
  _count?: { sessions: number };
};
type DoctorSessionLike = {
  id: string;
  doctorId: string;
  sessionType: SessionType;
  startTime: string;
  maxTokens: number;
  daysOfWeek: number[];
};
type StaffLike = {
  id: string;
  clinicId: string;
  name: string;
  role: StaffRole;
  username?: string | null;
};

export function toAdminClinic(c: ClinicLike): AdminClinicView {
  return {
    id: c.id,
    name: c.name,
    address: c.address ?? null,
    contactNumber: c.contactNumber ?? null,
  };
}

export function toAdminDoctor(d: DoctorLike): AdminDoctorView {
  return {
    id: d.id,
    clinicId: d.clinicId,
    name: d.name,
    specialization: d.specialization ?? null,
    consultationFee: d.consultationFee,
    avgConsultMinutes: d.avgConsultMinutes,
    photoUrl: d.photoUrl ?? null,
    username: d.username ?? null,
    canSignIn: Boolean(d.username && d.passwordHash),
    sessionCount: d._count?.sessions ?? 0,
  };
}

export function toAdminDoctorSession(s: DoctorSessionLike): AdminDoctorSessionView {
  return {
    id: s.id,
    doctorId: s.doctorId,
    sessionType: s.sessionType,
    startTime: s.startTime,
    maxTokens: s.maxTokens,
    daysOfWeek: s.daysOfWeek,
  };
}

export function toAdminStaff(s: StaffLike): AdminStaffView {
  return {
    id: s.id,
    clinicId: s.clinicId,
    name: s.name,
    role: s.role,
    username: s.username ?? null,
  };
}

// ─── Write inputs ───

export interface CreateClinicInput {
  name: string;
  address?: string | null;
  contactNumber?: string | null;
}

export interface UpdateClinicInput {
  name?: string;
  address?: string | null;
  contactNumber?: string | null;
}

export interface CreateDoctorInput {
  name: string;
  specialization?: string | null;
  consultationFee?: number;
  avgConsultMinutes?: number;
  photoUrl?: string | null;
  username?: string;
  password?: string;
}

export interface UpdateDoctorInput {
  name?: string;
  specialization?: string | null;
  consultationFee?: number;
  avgConsultMinutes?: number;
  photoUrl?: string | null;
  username?: string;
  password?: string;
}

export interface CreateDoctorSessionInput {
  sessionType: SessionType;
  startTime: string; // "HH:MM"
  maxTokens: number;
  daysOfWeek: number[]; // 0=Sun … 6=Sat, non-empty
}

export interface UpdateDoctorSessionInput {
  sessionType?: SessionType;
  startTime?: string;
  maxTokens?: number;
  daysOfWeek?: number[];
}

export interface CreateStaffInput {
  name: string;
  role: StaffRole;
  username?: string;
  password: string;
}

export interface UpdateStaffInput {
  name?: string;
  role?: StaffRole;
  username?: string;
  password?: string;
}

// ─── Analytics read projection ───

export interface AnalyticsDailyView {
  clinicId: string;
  date: string; // YYYY-MM-DD
  patientsSeen: number;
  noShows: number;
  avgWaitTime: number; // minutes
  avgConsultTime: number; // minutes
}

type AnalyticsLike = {
  clinicId: string;
  date: Date;
  patientsSeen: number;
  noShows: number;
  avgWaitTime: number;
  avgConsultTime: number;
};

export function toAnalyticsView(a: AnalyticsLike): AnalyticsDailyView {
  return {
    clinicId: a.clinicId,
    date: a.date.toISOString().slice(0, 10),
    patientsSeen: a.patientsSeen,
    noShows: a.noShows,
    avgWaitTime: a.avgWaitTime,
    avgConsultTime: a.avgConsultTime,
  };
}
