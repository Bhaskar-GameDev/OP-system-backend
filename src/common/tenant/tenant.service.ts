import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionClaims } from '../../auth/auth-token.service';

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

  /**
   * Authorize a queue/session action on `doctorId` for the calling principal.
   * The doctorId always arrives from the REQUEST, so it must never be trusted —
   * this is the single gate for every `/queue/*` operation:
   *   DOCTOR -> may only act on their OWN queue (token doctorId must match)
   *   STAFF  -> doctor must be in the staff member's clinic
   *   ADMIN  -> doctor must be in the admin's hospital (any clinic under it)
   * A doctor outside the caller's scope is not-found/forbidden, never actionable.
   */
  async assertQueueAccess(
    claims: SessionClaims | undefined,
    doctorId: string,
  ): Promise<void> {
    if (!claims) throw new ForbiddenException('missing identity');

    if (claims.role === 'DOCTOR') {
      const own = claims.doctorId ?? claims.sub;
      if (own !== doctorId) {
        throw new ForbiddenException('you may only act on your own queue');
      }
      return;
    }

    if (claims.role === 'STAFF') {
      if (!claims.clinicId) throw new ForbiddenException('token missing clinic scope');
      const doctor = await this.prisma.doctor.findUnique({
        where: { id: doctorId },
        select: { clinicId: true },
      });
      if (!doctor) throw new NotFoundException('doctor not found');
      if (doctor.clinicId !== claims.clinicId) {
        throw new ForbiddenException('doctor belongs to another clinic');
      }
      return;
    }

    if (claims.role === 'ADMIN') {
      await this.assertDoctorInHospital(
        TenantService.hospitalIdOrThrow(claims.hospitalId),
        doctorId,
      );
      return;
    }

    throw new ForbiddenException('insufficient role for queue operations');
  }

  /**
   * Authorize an action targeting a specific booking id (also request-supplied).
   * PATIENT -> must own it; DOCTOR -> must be their booking; STAFF/ADMIN -> the
   * booking's clinic must fall inside their clinic/hospital scope.
   */
  async assertBookingAccess(
    claims: SessionClaims | undefined,
    bookingId: string,
  ): Promise<void> {
    if (!claims) throw new ForbiddenException('missing identity');

    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { patientId: true, doctorId: true },
    });
    if (!booking) throw new NotFoundException('booking not found');

    if (claims.role === 'PATIENT') {
      if (booking.patientId !== claims.sub) {
        throw new NotFoundException('booking not found'); // no existence leak
      }
      return;
    }
    // DOCTOR / STAFF / ADMIN all reduce to "is this booking's doctor in my scope".
    await this.assertQueueAccess(claims, booking.doctorId);
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
