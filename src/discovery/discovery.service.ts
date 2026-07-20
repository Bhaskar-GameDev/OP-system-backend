import { Injectable, NotFoundException } from '@nestjs/common';
import { BookingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { SessionResolverService } from '../bookings/session-resolver.service';
import {
  Page,
  PublicClinic,
  PublicDoctor,
  PublicDoctorSchedule,
  PublicTodaySession,
  PublicUpcomingSession,
  toPublicClinic,
  toPublicDoctor,
  toPublicDoctorSchedule,
  toPublicSessionTemplate,
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
  photoUrl: true,
  clinicId: true,
  clinic: { select: CLINIC_SELECT },
} satisfies Prisma.DoctorSelect;

// Profile + schedule: the doctor's public facts plus their recurring sessions.
const SCHEDULE_SELECT = {
  ...DOCTOR_SELECT,
  sessions: {
    select: {
      sessionType: true,
      startTime: true,
      maxTokens: true,
      daysOfWeek: true,
    },
  },
} satisfies Prisma.DoctorSelect;

/** How many days ahead (incl. today) the public schedule looks. */
const SCHEDULE_DAYS = 7;

/** Statuses that occupy a session's capacity. CANCELLED / EXPIRED free it — so
 *  a cancelled booking immediately reopens the slot for someone else. */
const SLOT_CONSUMING: BookingStatus[] = [
  BookingStatus.PENDING_PAYMENT,
  BookingStatus.BOOKED,
  BookingStatus.ACTIVE,
  BookingStatus.COMPLETED,
  BookingStatus.NO_SHOW,
];

@Injectable()
export class DiscoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionResolver: SessionResolverService,
  ) {}

  /**
   * Same-day "Join Queue" state: the session the patient would join right now
   * (time window + fee), or that none remains today. No capacity gate — token
   * count is unbounded — so this never reports "full", only scheduled / ended.
   */
  async getTodaySession(doctorId: string): Promise<PublicTodaySession> {
    const resolved = await this.sessionResolver.resolveToday(doctorId);
    if (resolved.status !== 'OPEN') {
      return { available: false, reason: resolved.reason };
    }
    const { sessionType, sessionDate, startTime, endTime, fee } = resolved.session;
    return {
      available: true,
      session: { sessionType, sessionDate, startTime, endTime, fee },
    };
  }

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

  /**
   * Public doctor schedule: the standing weekly sessions plus the concrete
   * bookable sessions over the next {@link SCHEDULE_DAYS} days, each annotated
   * with live capacity (occupied vs maxTokens). Occupancy is the count of live
   * (non-cancelled / non-expired) bookings for that date+session — so a cancel
   * frees a slot and it shows as available again, consistent with what the
   * cancel/reschedule flows enforce.
   */
  async getDoctorSchedule(id: string): Promise<PublicDoctorSchedule> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id },
      select: SCHEDULE_SELECT,
    });
    if (!doctor) throw new NotFoundException('doctor not found');

    const weekly = doctor.sessions
      .map(toPublicSessionTemplate)
      .sort((a, b) => a.sessionType.localeCompare(b.sessionType) || a.startTime.localeCompare(b.startTime));

    // Expand the weekly templates onto the next 7 calendar days (server-local,
    // matching how sessions are keyed elsewhere). Only days the doctor sits.
    const base = startOfLocalDay(new Date());
    const last = new Date(base);
    last.setDate(base.getDate() + SCHEDULE_DAYS - 1);
    const occupancy = await this.occupancyBySession(id, base, last);

    const upcoming: PublicUpcomingSession[] = [];
    for (let i = 0; i < SCHEDULE_DAYS; i++) {
      const day = new Date(base);
      day.setDate(base.getDate() + i);
      const dow = day.getDay();
      const date = ymdLocal(day);
      for (const s of doctor.sessions) {
        if (!s.daysOfWeek.includes(dow)) continue;
        const tokensIssued = occupancy.get(`${date}:${s.sessionType}`) ?? 0;
        upcoming.push({
          date,
          dayOfWeek: dow,
          sessionType: s.sessionType,
          startTime: s.startTime,
          maxTokens: s.maxTokens,
          tokensIssued,
          available: tokensIssued < s.maxTokens,
        });
      }
    }
    upcoming.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));

    return toPublicDoctorSchedule(doctor, weekly, upcoming);
  }

  /**
   * Live booking count per (date, sessionType) across the window, in ONE grouped
   * query. Key: `YYYY-MM-DD:SESSIONTYPE`. Cancelled/expired bookings are excluded
   * so they don't keep a slot occupied.
   */
  private async occupancyBySession(
    doctorId: string,
    from: Date,
    to: Date,
  ): Promise<Map<string, number>> {
    const rows = await this.prisma.booking.groupBy({
      by: ['sessionDate', 'sessionType'],
      where: {
        doctorId,
        sessionDate: { gte: from, lte: to },
        status: { in: SLOT_CONSUMING },
      },
      _count: { _all: true },
    });
    const map = new Map<string, number>();
    for (const r of rows) {
      map.set(`${ymdLocal(r.sessionDate)}:${r.sessionType}`, r._count._all);
    }
    return map;
  }
}

/** Local midnight of the given instant. */
function startOfLocalDay(at: Date): Date {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Local-calendar YYYY-MM-DD (never UTC — avoids the date rolling back a day). */
function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
