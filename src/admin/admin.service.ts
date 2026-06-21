import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { PasswordService } from '../auth/password.service';
import {
  AdminClinicView,
  AdminDoctorView,
  AdminStaffView,
  CreateDoctorInput,
  CreateStaffInput,
  UpdateClinicInput,
  UpdateDoctorInput,
  UpdateStaffInput,
  toAdminClinic,
  toAdminDoctor,
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
  username: true,
} satisfies Prisma.DoctorSelect;

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
        consultationFee: input.consultationFee ?? 0,
        avgConsultMinutes: input.avgConsultMinutes ?? 10,
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
    if (input.consultationFee !== undefined) data.consultationFee = input.consultationFee;
    if (input.avgConsultMinutes !== undefined) data.avgConsultMinutes = input.avgConsultMinutes;
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
    clinicId: string,
    input: CreateStaffInput,
  ): Promise<AdminStaffView> {
    const created = await this.prisma.staff.create({
      data: {
        clinicId, // from token scope, never the request body
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

function notFoundIfMissing(e: unknown, message: string): unknown {
  if (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    e.code === 'P2025' // record not found
  ) {
    return new NotFoundException(message);
  }
  return e;
}
