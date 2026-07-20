import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Shared tenant-isolation enforcement. The single place staff-side queries go to
 * resolve "what may this hospital see" and "does this resource belong to my
 * hospital". The default path is SCOPED: callers ask for the hospital's clinic
 * set (and filter by it) or assert a specific resource is in-tenant — there is no
 * unscoped read helper here, so a forgotten filter is a missing call, not a
 * silent leak.
 *
 * Resources reachable from a hospital:
 *   Hospital -> Clinic (clinic.hospitalId)
 *            -> Staff   (staff.hospitalId)
 *            -> Doctor  (doctor.clinic.hospitalId)
 *            -> Booking / AuditLog / Session (via doctor -> clinic -> hospital)
 */
@Injectable()
export class TenantService {
  constructor(private readonly prisma: PrismaService) {}

  /** Clinic ids owned by a hospital. Used to scope cross-clinic aggregates
   *  (reports, analytics, audit) with a `clinicId IN (...)` filter. */
  async clinicIdsForHospital(hospitalId: string): Promise<string[]> {
    const rows = await this.prisma.clinic.findMany({
      where: { hospitalId },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** Assert a clinic exists AND belongs to the hospital. A real clinic in
   *  ANOTHER hospital is treated as not-found (no cross-tenant existence leak). */
  async assertClinicInHospital(hospitalId: string, clinicId: string): Promise<void> {
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { hospitalId: true },
    });
    if (!clinic || clinic.hospitalId !== hospitalId) {
      throw new NotFoundException('clinic not found');
    }
  }

  /** Assert a doctor belongs to the hospital (via its clinic). Returns the
   *  doctor's clinicId for callers that need it. Foreign doctor -> not-found. */
  async assertDoctorInHospital(hospitalId: string, doctorId: string): Promise<string> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { clinicId: true, clinic: { select: { hospitalId: true } } },
    });
    if (!doctor || doctor.clinic.hospitalId !== hospitalId) {
      throw new NotFoundException('doctor not found');
    }
    return doctor.clinicId;
  }

  /** True if the doctor belongs to the hospital — non-throwing form for the
   *  realtime path (Socket.io join authorization). */
  async doctorInHospital(hospitalId: string, doctorId: string): Promise<boolean> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { clinic: { select: { hospitalId: true } } },
    });
    return !!doctor && doctor.clinic.hospitalId === hospitalId;
  }

  /** The tenant boundary from a token — throws if a staff/doctor token predates
   *  the multi-tenant migration and carries no hospitalId (fail closed). */
  static hospitalIdOrThrow(hospitalId: string | undefined): string {
    if (!hospitalId) {
      throw new ForbiddenException('token missing hospital scope');
    }
    return hospitalId;
  }
}
