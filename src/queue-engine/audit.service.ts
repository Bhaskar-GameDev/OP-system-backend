import { Injectable, Logger } from '@nestjs/common';
import { Prisma, SessionType } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { TenantService } from '../common/tenant/tenant.service';
import { SessionClaims } from '../auth/auth-token.service';
import {
  AuditLogPage,
  AuditLogView,
  AuditQuery,
} from './dto/audit-query.dto';

export type AuditAction =
  | 'DONE'
  | 'NO_SHOW'
  | 'SKIP'
  | 'PRIORITY'
  | 'REINSERT'
  | 'CANCEL' // patient cancelled their booking
  | 'RESCHEDULE'; // patient moved their booking to another session

export interface AuditEntry {
  action: AuditAction;
  doctorId: string;
  sessionDate: string; // YYYY-MM-DD
  sessionType: SessionType;
  token?: string;
  bookingId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Records queue-control actions for compliance. The write happens AFTER the
 * mutation has already committed (Redis + DB), so a failed audit write must not
 * surface as a 500 that wrongly implies the action failed — it is logged loudly
 * instead. Append-only: no update/delete paths exist.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
  ) {}

  async record(actor: SessionClaims, entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: actor.sub,
          actorRole: actor.role,
          clinicId: actor.clinicId ?? null,
          action: entry.action,
          doctorId: entry.doctorId,
          sessionDate: new Date(entry.sessionDate),
          sessionType: entry.sessionType,
          token: entry.token ?? null,
          bookingId: entry.bookingId ?? null,
          metadata: (entry.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
    } catch (err) {
      this.logger.error(
        `audit write failed (${entry.action} by ${actor.sub}): ${(err as Error).message}`,
      );
    }
  }

  /**
   * Read the audit trail, newest-first, scoped to the caller:
   *   - DOCTOR sees actions on their own sessions (by doctorId);
   *   - STAFF sees their own clinic (by clinicId);
   *   - ADMIN sees their whole HOSPITAL — every clinic under their hospitalId.
   * A token lacking the scope it needs is filtered to the empty set rather than
   * leaking cross-tenant rows. Read-only — there is no update/delete path.
   *
   * Names are NOT stored on the row (actor/patient could be renamed); they are
   * resolved at read time with batched lookups so the page reflects current
   * records and the trail itself stays immutable.
   */
  async query(actor: SessionClaims, q: AuditQuery): Promise<AuditLogPage> {
    const where: Prisma.AuditLogWhereInput = {};

    if (actor.role === 'DOCTOR') {
      where.doctorId = actor.doctorId ?? actor.sub;
    } else if (actor.role === 'ADMIN') {
      // Hospital-wide: all clinics under the admin's hospital. A token without a
      // hospital scope resolves to no clinics (empty -> no rows).
      const clinicIds = actor.hospitalId
        ? await this.tenant.clinicIdsForHospital(actor.hospitalId)
        : [];
      where.clinicId = { in: clinicIds.length ? clinicIds : ['__none__'] };
    } else {
      // STAFF — single clinic. A null clinic on the token would leak
      // cross-clinic rows, so guard against it explicitly.
      where.clinicId = actor.clinicId ?? '__none__';
    }

    if (q.action) where.action = q.action;
    if (q.actorId) where.actorId = q.actorId;
    if (q.dateFrom || q.dateTo) {
      where.createdAt = {};
      if (q.dateFrom) where.createdAt.gte = q.dateFrom;
      if (q.dateTo) where.createdAt.lt = q.dateTo;
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: q.offset,
        take: q.limit,
      }),
    ]);

    // Batch-resolve display names (actor = staff or doctor; patient via booking).
    const actorIds = [...new Set(rows.map((r) => r.actorId))];
    const doctorIds = [...new Set(rows.map((r) => r.doctorId))];
    const bookingIds = [
      ...new Set(rows.map((r) => r.bookingId).filter((b): b is string => !!b)),
    ];

    const [staff, doctors, bookings] = await Promise.all([
      this.prisma.staff.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true },
      }),
      this.prisma.doctor.findMany({
        where: { id: { in: [...new Set([...actorIds, ...doctorIds])] } },
        select: { id: true, name: true },
      }),
      bookingIds.length
        ? this.prisma.booking.findMany({
            where: { id: { in: bookingIds } },
            select: { id: true, patient: { select: { name: true } } },
          })
        : Promise.resolve([]),
    ]);

    const staffName = new Map(staff.map((s) => [s.id, s.name]));
    const doctorName = new Map(doctors.map((d) => [d.id, d.name]));
    const patientByBooking = new Map(
      bookings.map((b) => [b.id, b.patient?.name ?? null]),
    );

    const entries: AuditLogView[] = rows.map((r) => ({
      id: r.id,
      timestamp: r.createdAt.toISOString(),
      // actorId is a staff id (STAFF/ADMIN) or a doctor id (DOCTOR action).
      staffName: staffName.get(r.actorId) ?? doctorName.get(r.actorId) ?? null,
      staffRole: r.actorRole,
      action: r.action as AuditAction,
      token: r.token,
      patientName: r.bookingId
        ? patientByBooking.get(r.bookingId) ?? null
        : null,
      doctorId: r.doctorId,
      doctorName: doctorName.get(r.doctorId) ?? null,
      sessionDate: r.sessionDate.toISOString().slice(0, 10),
      sessionType: r.sessionType,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    }));

    return { entries, total, limit: q.limit, offset: q.offset };
  }
}
