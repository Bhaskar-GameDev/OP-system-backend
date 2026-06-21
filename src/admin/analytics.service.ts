import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BookingHistory, BookingStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AnalyticsDailyView, toAnalyticsView } from './admin.dto';

const MS_PER_MIN = 60_000;

/**
 * Daily clinic analytics.
 *
 * The summary job is SCHEDULED to run AFTER the 2am archival sweep (2:30am): by
 * then the completed day's terminal bookings have been moved into the
 * append-only booking_history, which this job reads. It writes one
 * analytics_daily row per clinic per day.
 *
 * patients_seen = COMPLETED count, no_shows = NO_SHOW count. The averages
 * (avg_wait_time / avg_consult_time) are computed ONLY from COMPLETED rows —
 * the only rows carrying real consultation timestamps. NO_SHOW/CANCELLED rows
 * are EXCLUDED from the averages, never folded in as zero (which would deflate
 * the mean).
 *
 * Read endpoints query ONLY analytics_daily — they never scan bookings or
 * booking_history for reporting (original spec requirement).
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // UTC midnight — matches how @db.Date (sessionDate) is stored/returned by
  // Prisma, so the range query and the upsert key line up across timezones.
  // INTENTIONALLY different from ArchivalService.startOfToday (LOCAL midnight):
  // that one bounds createdAt (a full timestamp), this one bounds a @db.Date
  // column. Do NOT "align" them — they serve different boundary purposes.
  private startOfDay(now = new Date()): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  /** 2:30am — after the 2am archival sweep has populated booking_history. */
  @Cron('30 2 * * *', { name: 'daily-summary' })
  async scheduledSummary(): Promise<void> {
    const { clinics } = await this.runDailySummary();
    if (clinics > 0) this.logger.log(`summarized ${clinics} clinic-day(s)`);
  }

  /**
   * Summarize the day that just settled (the local day BEFORE `now`). Reads
   * that day's booking_history rows, groups by clinic, and upserts one
   * analytics_daily row per clinic. Idempotent: re-running overwrites the same
   * (clinic, date) row.
   */
  async runDailySummary(now = new Date()): Promise<{ clinics: number }> {
    const dayEnd = this.startOfDay(now); // start of today (UTC)
    const dayStart = new Date(dayEnd);
    dayStart.setUTCDate(dayStart.getUTCDate() - 1); // start of yesterday (UTC)

    const rows = await this.prisma.bookingHistory.findMany({
      where: { sessionDate: { gte: dayStart, lt: dayEnd } },
    });

    const byClinic = new Map<string, BookingHistory[]>();
    for (const r of rows) {
      const list = byClinic.get(r.clinicId) ?? [];
      list.push(r);
      byClinic.set(r.clinicId, list);
    }

    for (const [clinicId, clinicRows] of byClinic) {
      const stats = this.summarize(clinicRows);
      await this.prisma.analyticsDaily.upsert({
        where: { uq_clinic_day: { clinicId, date: dayStart } },
        create: { clinicId, date: dayStart, ...stats },
        update: { ...stats },
      });
    }

    return { clinics: byClinic.size };
  }

  /**
   * Pure stats for one clinic-day. Averages use only COMPLETED rows that have
   * both timestamps present; rows without a usable interval are skipped rather
   * than counted as zero.
   */
  private summarize(rows: BookingHistory[]): {
    patientsSeen: number;
    noShows: number;
    avgWaitTime: number;
    avgConsultTime: number;
  } {
    const completed = rows.filter((r) => r.finalStatus === BookingStatus.COMPLETED);
    const noShows = rows.filter((r) => r.finalStatus === BookingStatus.NO_SHOW).length;

    const waits: number[] = [];
    const consults: number[] = [];
    for (const r of completed) {
      if (r.consultationStartedAt) {
        // wait = booked -> consultation start
        waits.push((r.consultationStartedAt.getTime() - r.bookedAt.getTime()) / MS_PER_MIN);
      }
      if (r.consultationStartedAt && r.consultationEndedAt) {
        consults.push(
          (r.consultationEndedAt.getTime() - r.consultationStartedAt.getTime()) / MS_PER_MIN,
        );
      }
    }

    return {
      patientsSeen: completed.length,
      noShows,
      avgWaitTime: mean(waits),
      avgConsultTime: mean(consults),
    };
  }

  // ─── Read endpoints (analytics_daily ONLY — never scans booking tables) ───

  async getDay(clinicId: string, date: Date): Promise<AnalyticsDailyView | null> {
    const row = await this.prisma.analyticsDaily.findUnique({
      where: { uq_clinic_day: { clinicId, date } },
    });
    return row ? toAnalyticsView(row) : null;
  }

  async getRange(clinicId: string, from?: Date, to?: Date): Promise<AnalyticsDailyView[]> {
    const date: { gte?: Date; lte?: Date } = {};
    if (from) date.gte = from;
    if (to) date.lte = to;

    const rows = await this.prisma.analyticsDaily.findMany({
      where: { clinicId, ...(from || to ? { date } : {}) },
      orderBy: { date: 'desc' },
    });
    return rows.map(toAnalyticsView);
  }
}

/** Mean rounded to whole minutes. Empty set -> 0 (no completed consults). */
function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
}
