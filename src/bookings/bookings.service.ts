import { Injectable } from '@nestjs/common';
import { BookingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  Page,
  PublicBooking,
  toPublicFromHistory,
  toPublicFromLive,
} from './booking.dto';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

const UPCOMING: BookingStatus[] = [
  BookingStatus.PENDING_PAYMENT,
  BookingStatus.BOOKED,
  BookingStatus.ACTIVE,
];
const TERMINAL: BookingStatus[] = [
  BookingStatus.COMPLETED,
  BookingStatus.NO_SHOW,
  BookingStatus.CANCELLED,
];

// explicit field allow-list at the query layer (no patient/auth fields fetched)
const LIVE_SELECT = {
  id: true,
  doctorId: true,
  source: true,
  tokenNumber: true,
  sessionDate: true,
  sessionType: true,
  status: true,
  consultationStartedAt: true,
  consultationEndedAt: true,
  createdAt: true,
  payment: { select: { status: true } },
} satisfies Prisma.BookingSelect;

@Injectable()
export class BookingsService {
  constructor(private readonly prisma: PrismaService) {}

  private clamp(page?: number, pageSize?: number) {
    const p = Number.isFinite(page) && (page as number) > 0 ? Math.floor(page as number) : 1;
    const raw = Number.isFinite(pageSize) && (pageSize as number) > 0 ? Math.floor(pageSize as number) : DEFAULT_PAGE_SIZE;
    const size = Math.min(raw, MAX_PAGE_SIZE);
    return { skip: (p - 1) * size, take: size, page: p, pageSize: size };
  }

  /** doctorId -> name, batched so the listing never N+1s. */
  private async doctorNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const docs = await this.prisma.doctor.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(docs.map((d) => [d.id, d.name]));
  }

  /** Upcoming = not-yet-settled live bookings (pending/booked/active). */
  async upcoming(patientId: string, page?: number, pageSize?: number): Promise<Page<PublicBooking>> {
    const { skip, take, page: p, pageSize: size } = this.clamp(page, pageSize);
    const where: Prisma.BookingWhereInput = { patientId, status: { in: UPCOMING } };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.booking.findMany({
        where,
        select: LIVE_SELECT,
        skip,
        take,
        orderBy: [{ sessionDate: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.booking.count({ where }),
    ]);
    const names = await this.doctorNames(rows.map((r) => r.doctorId));
    return {
      items: rows.map((r) => toPublicFromLive(r, names.get(r.doctorId) ?? null)),
      page: p,
      pageSize: size,
      total,
    };
  }

  /**
   * Past = settled bookings, drawn from BOTH the live table (recent terminal,
   * not yet archived) and booking_history (archived). The archival job moves
   * old terminal bookings out of `bookings`, so a complete history must union
   * the two. Patient-scoped, so the result is naturally bounded — merged and
   * paginated in memory.
   */
  async past(patientId: string, page?: number, pageSize?: number): Promise<Page<PublicBooking>> {
    const { skip, take, page: p, pageSize: size } = this.clamp(page, pageSize);

    const [liveTerminal, history] = await this.prisma.$transaction([
      this.prisma.booking.findMany({
        where: { patientId, status: { in: TERMINAL } },
        select: LIVE_SELECT,
      }),
      this.prisma.bookingHistory.findMany({
        where: { patientId },
      }),
    ]);

    const names = await this.doctorNames([
      ...liveTerminal.map((b) => b.doctorId),
      ...history.map((h) => h.doctorId),
    ]);

    const merged: PublicBooking[] = [
      ...liveTerminal.map((b) => toPublicFromLive(b, names.get(b.doctorId) ?? null)),
      ...history.map((h) => toPublicFromHistory(h, names.get(h.doctorId) ?? null)),
    ];
    // most recent first: by session date, then by creation time
    merged.sort((a, b) =>
      b.sessionDate.localeCompare(a.sessionDate) || b.createdAt.localeCompare(a.createdAt),
    );

    return {
      items: merged.slice(skip, skip + take),
      page: p,
      pageSize: size,
      total: merged.length,
    };
  }
}
