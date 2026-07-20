import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SessionType } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { TenantService } from '../common/tenant/tenant.service';
import { PasswordService } from '../auth/password.service';
import {
  AdminClinicView,
  AdminDoctorSessionView,
  AdminDoctorView,
  AdminStaffView,
  CreateClinicInput,
  CreateDoctorInput,
  CreateDoctorSessionInput,
  CreateStaffInput,
  UpdateClinicInput,
  UpdateDoctorInput,
  UpdateDoctorSessionInput,
  UpdateStaffInput,
  toAdminClinic,
  toAdminDoctor,
  toAdminDoctorSession,
  toAdminStaff,
} from './admin.dto';

// Query-layer allow-lists: password material is NEVER fetched, so it cannot
// leak regardless of downstream handling (defense-in-depth with the DTO
// mappers). Note loginCredentials/passwordHash are absent by construction.
const CLINIC_SELECT = {
  id: true,
  name: true,
  address: true,
  contactNumber: true,
} satisfies Prisma.ClinicSelect;

const DOCTOR_SELECT = {
  id: true,
  clinicId: true,
  name: true,
  specialization: true,
  consultationFee: true,
  avgConsultMinutes: true,
  photoUrl: true,
  username: true,
} satisfies Prisma.DoctorSelect;

const SESSION_SELECT = {
  id: true,
  doctorId: true,
  sessionType: true,
  startTime: true,
  maxTokens: true,
  daysOfWeek: true,
} satisfies Prisma.DoctorSessionSelect;

const STAFF_SELECT = {
  id: true,
  clinicId: true,
  name: true,
  role: true,
  username: true,
} satisfies Prisma.StaffSelect;

/**
 * Admin Portal CRUD. EVERY method is scoped to the caller's own clinicId, which
 * the controller derives from the authenticated admin's JWT — never from a
 * request parameter. A clinicId in a request body is only ever used to CONFIRM
 * it matches the token (assertClinic); a mismatch is 403, never a scope switch.
 *
 * For edit/delete of an existing doctor/staff row, scope is re-checked against
 * the LOADED row's clinicId: an admin from Clinic A passing Clinic B's real
 * doctor id gets 403, because that doctor's clinicId != the token's clinicId.
 *
 * No clinic-creation endpoint exists — onboarding is a seed script. Clinic
 * management is edit-only, scoped to the admin's own clinic.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tenant: TenantService,
  ) {}

  // ─── Clinic (edit-only, own clinic) ───

  async getClinic(clinicId: string): Promise<AdminClinicView> {
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: clinicId },
      select: CLINIC_SELECT,
    });
    if (!clinic) throw new NotFoundException('clinic not found');
    return toAdminClinic(clinic);
  }

  async updateClinic(
    clinicId: string,
    input: UpdateClinicInput,
  ): Promise<AdminClinicView> {
    const data: Prisma.ClinicUpdateInput = {};
    if (input.name !== undefined) data.name = req(input.name, 'name');
    if (input.address !== undefined) data.address = input.address;
    if (input.contactNumber !== undefined) data.contactNumber = input.contactNumber;

    try {
      const updated = await this.prisma.clinic.update({
        where: { id: clinicId },
        data,
        select: CLINIC_SELECT,
      });
      return toAdminClinic(updated);
    } catch (e) {
      throw notFoundIfMissing(e, 'clinic not found');
    }
  }

  // ─── Clinics (hospital-scoped: an ADMIN's sibling clinics) ───
  // An ADMIN manages every clinic under their OWN hospital — list/get/create are
  // bounded to the token's hospitalId. A clinic in another hospital is treated as
  // not-found (no cross-tenant existence leak).

  async listClinics(hospitalId: string): Promise<AdminClinicView[]> {
    const rows = await this.prisma.clinic.findMany({
      where: { hospitalId },
      select: CLINIC_SELECT,
      orderBy: { name: 'asc' },
    });
    return rows.map(toAdminClinic);
  }

  async getClinicById(hospitalId: string, clinicId: string): Promise<AdminClinicView> {
    await this.tenant.assertClinicInHospital(hospitalId, clinicId);
    return this.getClinic(clinicId);
  }

  async createClinic(
    hospitalId: string,
    input: CreateClinicInput,
  ): Promise<AdminClinicView> {
    const created = await this.prisma.clinic.create({
      data: {
        // hospitalId is taken from the TOKEN scope, never from the request body.
        hospital: { connect: { id: hospitalId } },
        name: req(input.name, 'name'),
        address: input.address ?? null,
        contactNumber: input.contactNumber ?? null,
      },
      select: CLINIC_SELECT,
    });
    return toAdminClinic(created);
  }

  // ─── Doctor CRUD (own clinic) ───

  async listDoctors(clinicId: string): Promise<AdminDoctorView[]> {
    const rows = await this.prisma.doctor.findMany({
      where: { clinicId },
      select: DOCTOR_SELECT,
      orderBy: { name: 'asc' },
    });
    return rows.map(toAdminDoctor);
  }

  async getDoctor(clinicId: string, doctorId: string): Promise<AdminDoctorView> {
    return toAdminDoctor(await this.loadOwnDoctor(clinicId, doctorId));
  }

  async createDoctor(
    clinicId: string,
    input: CreateDoctorInput,
  ): Promise<AdminDoctorView> {
    const created = await this.prisma.doctor.create({
      data: {
        // clinicId is taken from the TOKEN scope, never from the request body.
        clinicId,
        name: req(input.name, 'name'),
        specialization: input.specialization ?? null,
        consultationFee: positiveFee(input.consultationFee) ?? 0,
        avgConsultMinutes: input.avgConsultMinutes ?? 10,
        photoUrl: input.photoUrl ?? null,
        username: input.username ?? null,
        passwordHash: input.password
          ? await this.passwords.hash(input.password)
          : null,
      },
      select: DOCTOR_SELECT,
    });
    return toAdminDoctor(created);
  }

  async updateDoctor(
    clinicId: string,
    doctorId: string,
    input: UpdateDoctorInput,
  ): Promise<AdminDoctorView> {
    await this.loadOwnDoctor(clinicId, doctorId); // 403/404 before mutating

    const data: Prisma.DoctorUpdateInput = {};
    if (input.name !== undefined) data.name = req(input.name, 'name');
    if (input.specialization !== undefined) data.specialization = input.specialization;
    if (input.consultationFee !== undefined) data.consultationFee = positiveFee(input.consultationFee);
    if (input.avgConsultMinutes !== undefined) data.avgConsultMinutes = input.avgConsultMinutes;
    if (input.photoUrl !== undefined) data.photoUrl = input.photoUrl;
    if (input.username !== undefined) data.username = input.username;
    if (input.password !== undefined) data.passwordHash = await this.passwords.hash(input.password);

    const updated = await this.prisma.doctor.update({
      where: { id: doctorId },
      data,
      select: DOCTOR_SELECT,
    });
    return toAdminDoctor(updated);
  }

  async deleteDoctor(clinicId: string, doctorId: string): Promise<void> {
    await this.loadOwnDoctor(clinicId, doctorId); // 403/404 before deleting
    await this.prisma.doctor.delete({ where: { id: doctorId } });
  }

  // ─── Staff CRUD (own clinic) ───

  async listStaff(clinicId: string): Promise<AdminStaffView[]> {
    const rows = await this.prisma.staff.findMany({
      where: { clinicId },
      select: STAFF_SELECT,
      orderBy: { name: 'asc' },
    });
    return rows.map(toAdminStaff);
  }

  async getStaff(clinicId: string, staffId: string): Promise<AdminStaffView> {
    return toAdminStaff(await this.loadOwnStaff(clinicId, staffId));
  }

  async createStaff(
    hospitalId: string,
    clinicId: string,
    input: CreateStaffInput,
  ): Promise<AdminStaffView> {
    const created = await this.prisma.staff.create({
      data: {
        // both scopes come from the token, never the request body
        hospitalId,
        clinicId,
        name: req(input.name, 'name'),
        role: input.role,
        username: input.username ?? null,
        loginCredentials: await this.passwords.hash(req(input.password, 'password')),
      },
      select: STAFF_SELECT,
    });
    return toAdminStaff(created);
  }

  async updateStaff(
    clinicId: string,
    staffId: string,
    input: UpdateStaffInput,
  ): Promise<AdminStaffView> {
    await this.loadOwnStaff(clinicId, staffId);

    const data: Prisma.StaffUpdateInput = {};
    if (input.name !== undefined) data.name = req(input.name, 'name');
    if (input.role !== undefined) data.role = input.role;
    if (input.username !== undefined) data.username = input.username;
    if (input.password !== undefined) data.loginCredentials = await this.passwords.hash(input.password);

    const updated = await this.prisma.staff.update({
      where: { id: staffId },
      data,
      select: STAFF_SELECT,
    });
    return toAdminStaff(updated);
  }

  async deleteStaff(clinicId: string, staffId: string): Promise<void> {
    await this.loadOwnStaff(clinicId, staffId);
    await this.prisma.staff.delete({ where: { id: staffId } });
  }

  // ─── Doctor session schedule (per doctor, own clinic) ───

  async listSessions(
    clinicId: string,
    doctorId: string,
  ): Promise<AdminDoctorSessionView[]> {
    await this.loadOwnDoctor(clinicId, doctorId); // 403/404 before reading
    const rows = await this.prisma.doctorSession.findMany({
      where: { doctorId },
      select: SESSION_SELECT,
      orderBy: [{ sessionType: 'asc' }, { startTime: 'asc' }],
    });
    return rows.map(toAdminDoctorSession);
  }

  async createSession(
    clinicId: string,
    doctorId: string,
    input: CreateDoctorSessionInput,
  ): Promise<AdminDoctorSessionView> {
    await this.loadOwnDoctor(clinicId, doctorId);

    const sessionType = parseSessionType(input.sessionType);
    const startTime = parseStartTime(input.startTime);
    const maxTokens = parseMaxTokens(input.maxTokens);
    const daysOfWeek = parseDays(input.daysOfWeek);

    await this.assertNoOverlap(doctorId, sessionType, daysOfWeek, null);

    const created = await this.prisma.doctorSession.create({
      data: { doctorId, sessionType, startTime, maxTokens, daysOfWeek },
      select: SESSION_SELECT,
    });
    return toAdminDoctorSession(created);
  }

  async updateSession(
    clinicId: string,
    doctorId: string,
    sessionId: string,
    input: UpdateDoctorSessionInput,
  ): Promise<AdminDoctorSessionView> {
    await this.loadOwnDoctor(clinicId, doctorId);
    const existing = await this.prisma.doctorSession.findUnique({
      where: { id: sessionId },
      select: SESSION_SELECT,
    });
    if (!existing || existing.doctorId !== doctorId) {
      throw new NotFoundException('session not found');
    }

    const data: Prisma.DoctorSessionUpdateInput = {};
    const nextType =
      input.sessionType !== undefined
        ? parseSessionType(input.sessionType)
        : existing.sessionType;
    const nextDays =
      input.daysOfWeek !== undefined ? parseDays(input.daysOfWeek) : existing.daysOfWeek;
    if (input.sessionType !== undefined) data.sessionType = nextType;
    if (input.startTime !== undefined) data.startTime = parseStartTime(input.startTime);
    if (input.maxTokens !== undefined) data.maxTokens = parseMaxTokens(input.maxTokens);
    if (input.daysOfWeek !== undefined) data.daysOfWeek = nextDays;

    // Re-check overlap against the resulting (type, days), ignoring this row.
    await this.assertNoOverlap(doctorId, nextType, nextDays, sessionId);

    const updated = await this.prisma.doctorSession.update({
      where: { id: sessionId },
      data,
      select: SESSION_SELECT,
    });
    return toAdminDoctorSession(updated);
  }

  async deleteSession(
    clinicId: string,
    doctorId: string,
    sessionId: string,
  ): Promise<void> {
    await this.loadOwnDoctor(clinicId, doctorId);
    const existing = await this.prisma.doctorSession.findUnique({
      where: { id: sessionId },
      select: { id: true, doctorId: true },
    });
    if (!existing || existing.doctorId !== doctorId) {
      throw new NotFoundException('session not found');
    }
    await this.prisma.doctorSession.delete({ where: { id: sessionId } });
  }

  /**
   * Overlap rule: a doctor may not hold two schedules of the SAME session type
   * that share a weekday. Checks all other rows of that type for a day-set
   * intersection. `ignoreId` excludes the row being updated.
   */
  private async assertNoOverlap(
    doctorId: string,
    sessionType: SessionType,
    daysOfWeek: number[],
    ignoreId: string | null,
  ): Promise<void> {
    const siblings = await this.prisma.doctorSession.findMany({
      where: {
        doctorId,
        sessionType,
        ...(ignoreId ? { id: { not: ignoreId } } : {}),
      },
      select: { daysOfWeek: true },
    });
    const wanted = new Set(daysOfWeek);
    for (const s of siblings) {
      const clash = s.daysOfWeek.find((d) => wanted.has(d));
      if (clash !== undefined) {
        throw new BadRequestException(
          `overlapping ${sessionType} session on day ${clash} (same day + session type)`,
        );
      }
    }
  }

  // ─── Scope enforcement ───

  /**
   * Load a doctor and assert it belongs to the caller's clinic. A doctor that
   * exists but belongs to a DIFFERENT clinic is treated as 403 — the admin has
   * no authority there even though the id is real.
   */
  private async loadOwnDoctor(clinicId: string, doctorId: string) {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: doctorId },
      select: DOCTOR_SELECT,
    });
    if (!doctor) throw new NotFoundException('doctor not found');
    if (doctor.clinicId !== clinicId) {
      throw new ForbiddenException('doctor belongs to another clinic');
    }
    return doctor;
  }

  private async loadOwnStaff(clinicId: string, staffId: string) {
    const staff = await this.prisma.staff.findUnique({
      where: { id: staffId },
      select: STAFF_SELECT,
    });
    if (!staff) throw new NotFoundException('staff not found');
    if (staff.clinicId !== clinicId) {
      throw new ForbiddenException('staff belongs to another clinic');
    }
    return staff;
  }
}

function req(v: string | undefined, field: string): string {
  if (v === undefined || v.trim() === '') {
    throw new BadRequestException(`${field} is required`);
  }
  return v;
}

/** Consultation fee must be a positive integer (in rupees). */
function positiveFee(v: number | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || v <= 0) {
    throw new BadRequestException('consultationFee must be a positive integer');
  }
  return v;
}

function parseSessionType(v: SessionType): SessionType {
  if (v !== SessionType.MORNING && v !== SessionType.EVENING) {
    throw new BadRequestException('sessionType must be MORNING or EVENING');
  }
  return v;
}

function parseStartTime(v: string): string {
  if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) {
    throw new BadRequestException('startTime must be "HH:MM" (24h)');
  }
  return v;
}

function parseMaxTokens(v: number): number {
  if (!Number.isInteger(v) || v <= 0) {
    throw new BadRequestException('maxTokens must be a positive integer');
  }
  return v;
}

function parseDays(v: number[]): number[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new BadRequestException('daysOfWeek must be a non-empty array');
  }
  for (const d of v) {
    if (!Number.isInteger(d) || d < 0 || d > 6) {
      throw new BadRequestException('daysOfWeek entries must be integers 0–6 (Sun–Sat)');
    }
  }
  return [...new Set(v)].sort((a, b) => a - b);
}

function notFoundIfMissing(e: unknown, message: string): unknown {
  if (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    e.code === 'P2025' // record not found
  ) {
    return new NotFoundException(message);
  }
  return e;
}
