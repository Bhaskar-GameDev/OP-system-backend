import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  Page,
  PublicClinic,
  PublicDoctor,
  toPublicClinic,
  toPublicDoctor,
} from './discovery.dto';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

// Field allow-lists enforced at the QUERY layer: password_hash / username are
// never even fetched, so they cannot leak regardless of downstream handling.
const CLINIC_SELECT = {
  id: true,
  name: true,
  address: true,
  contactNumber: true,
} satisfies Prisma.ClinicSelect;

const DOCTOR_SELECT = {
  id: true,
  name: true,
  specialization: true,
  consultationFee: true,
  clinicId: true,
  clinic: { select: CLINIC_SELECT },
} satisfies Prisma.DoctorSelect;

@Injectable()
export class DiscoveryService {
  constructor(private readonly prisma: PrismaService) {}

  private clamp(page?: number, pageSize?: number): { skip: number; take: number; page: number; pageSize: number } {
    const p = Number.isFinite(page) && (page as number) > 0 ? Math.floor(page as number) : 1;
    const rawSize = Number.isFinite(pageSize) && (pageSize as number) > 0 ? Math.floor(pageSize as number) : DEFAULT_PAGE_SIZE;
    const size = Math.min(rawSize, MAX_PAGE_SIZE);
    return { skip: (p - 1) * size, take: size, page: p, pageSize: size };
  }

  async searchClinics(query: string, page?: number, pageSize?: number): Promise<Page<PublicClinic>> {
    const { skip, take, page: p, pageSize: size } = this.clamp(page, pageSize);
    const where: Prisma.ClinicWhereInput = query
      ? { name: { contains: query, mode: 'insensitive' } }
      : {};

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.clinic.findMany({ where, select: CLINIC_SELECT, skip, take, orderBy: { name: 'asc' } }),
      this.prisma.clinic.count({ where }),
    ]);
    return { items: rows.map(toPublicClinic), page: p, pageSize: size, total };
  }

  async getClinic(id: string): Promise<PublicClinic> {
    const clinic = await this.prisma.clinic.findUnique({ where: { id }, select: CLINIC_SELECT });
    if (!clinic) throw new NotFoundException('clinic not found');
    return toPublicClinic(clinic);
  }

  async searchDoctors(query: string, page?: number, pageSize?: number): Promise<Page<PublicDoctor>> {
    const { skip, take, page: p, pageSize: size } = this.clamp(page, pageSize);
    // case-insensitive match on name OR specialization
    const where: Prisma.DoctorWhereInput = query
      ? {
          OR: [
            { name: { contains: query, mode: 'insensitive' } },
            { specialization: { contains: query, mode: 'insensitive' } },
          ],
        }
      : {};

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.doctor.findMany({ where, select: DOCTOR_SELECT, skip, take, orderBy: { name: 'asc' } }),
      this.prisma.doctor.count({ where }),
    ]);
    return { items: rows.map(toPublicDoctor), page: p, pageSize: size, total };
  }

  async getDoctor(id: string): Promise<PublicDoctor> {
    const doctor = await this.prisma.doctor.findUnique({ where: { id }, select: DOCTOR_SELECT });
    if (!doctor) throw new NotFoundException('doctor not found');
    return toPublicDoctor(doctor);
  }
}
