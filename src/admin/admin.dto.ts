import { StaffRole } from '@prisma/client';

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
  username: string | null;
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
  username?: string | null;
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
    username: d.username ?? null,
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
  username?: string;
  password?: string;
}

export interface UpdateDoctorInput {
  name?: string;
  specialization?: string | null;
  consultationFee?: number;
  avgConsultMinutes?: number;
  username?: string;
  password?: string;
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
