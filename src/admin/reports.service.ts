import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  ReportBucket,
  ReportDoctorStat,
  ReportPeakHour,
  ReportSummary,
  ReportTotals,
  ReportTrendPoint,
} from './reports.dto';

/**
 * On-demand operational reporting. EVERY query is TENANT-scoped by a set of
 * clinic ids derived from the caller's token (STAFF -> their one clinic; ADMIN ->
 * every clinic under their hospital), never a request param. All aggregation is
 * pushed into Postgres — rows are never pulled into JS to be counted/summed.
 *
 * Data source is a UNION of the live `bookings` table (today / not-yet-archived)
 * and the append-only `booking_history` (settled past days, denormalised with
 * clinic_id + payment fields). A booking is in exactly ONE of the two tables
 * (archival deletes from bookings as it writes history), so UNION ALL never
 * double-counts. BOTH halves are filtered by the clinic-id set, so a hospital's
 * aggregates can never include another hospital's bookings.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(
    clinicIds: string[],
    from: string | null,
    to: string | null,
    bucket: ReportBucket,
  ): Promise<ReportSummary> {
    const [totals, trend, doctors, peakHours] = await Promise.all([
      this.totals(clinicIds, from, to),
      this.trend(clinicIds, from, to, bucket),
      this.doctors(clinicIds, from, to),
      this.peakHours(clinicIds, from, to),
    ]);
    return { range: { from, to, bucket }, totals, trend, doctors, peakHours };
  }

  // ─── Per-metric aggregations ───

  private async totals(
    clinicIds: string[],
    from: string | null,
    to: string | null,
  ): Promise<ReportTotals> {
    const ev = this.events(clinicIds, from, to);
    const rows = await this.prisma.$queryRaw<
      {
        total: number;
        online: number;
        walk_in: number;
        completed: number;
        no_shows: number;
        revenue_paise: number;
        avg_wait_minutes: number | null;
      }[]
    >(Prisma.sql`
      WITH ev AS (${ev})
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE source IN ('APP','VOICE'))::int AS online,
        COUNT(*) FILTER (WHERE source = 'WALK_IN')::int AS walk_in,
        COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
        COUNT(*) FILTER (WHERE status = 'NO_SHOW')::int AS no_shows,
        COALESCE(SUM(revenue), 0)::float8 AS revenue_paise,
        (AVG(EXTRACT(EPOCH FROM (started_at - booked_at)) / 60.0)
          FILTER (WHERE started_at IS NOT NULL))::float8 AS avg_wait_minutes
      FROM ev
    `);
    const r = rows[0];
    return {
      total: r.total,
      online: r.online,
      walkIn: r.walk_in,
      completed: r.completed,
      noShows: r.no_shows,
      revenuePaise: Math.round(r.revenue_paise),
      avgWaitMinutes: Math.round(r.avg_wait_minutes ?? 0),
    };
  }

  private async trend(
    clinicIds: string[],
    from: string | null,
    to: string | null,
    bucket: ReportBucket,
  ): Promise<ReportTrendPoint[]> {
    const ev = this.events(clinicIds, from, to);
    const rows = await this.prisma.$queryRaw<
      {
        bucket: Date;
        total: number;
        online: number;
        walk_in: number;
        revenue_paise: number;
      }[]
    >(Prisma.sql`
      WITH ev AS (${ev})
      SELECT
        date_trunc(${bucket}, session_date)::date AS bucket,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE source IN ('APP','VOICE'))::int AS online,
        COUNT(*) FILTER (WHERE source = 'WALK_IN')::int AS walk_in,
        COALESCE(SUM(revenue), 0)::float8 AS revenue_paise
      FROM ev
      GROUP BY 1
      ORDER BY 1
    `);
    return rows.map((r) => ({
      bucket: ymd(r.bucket),
      total: r.total,
      online: r.online,
      walkIn: r.walk_in,
      revenuePaise: Math.round(r.revenue_paise),
    }));
  }

  private async doctors(
    clinicIds: string[],
    from: string | null,
    to: string | null,
  ): Promise<ReportDoctorStat[]> {
    const ev = this.events(clinicIds, from, to);
    const rows = await this.prisma.$queryRaw<
      {
        doctor_id: string;
        name: string;
        bookings: number;
        completed: number;
        sessions: number;
        revenue_paise: number;
        avg_wait_minutes: number | null;
      }[]
    >(Prisma.sql`
      WITH ev AS (${ev})
      SELECT
        ev.doctor_id,
        doc.name AS name,
        COUNT(*)::int AS bookings,
        COUNT(*) FILTER (WHERE ev.status = 'COMPLETED')::int AS completed,
        COUNT(DISTINCT (ev.session_date::text || '|' || ev.session_type))::int AS sessions,
        COALESCE(SUM(ev.revenue), 0)::float8 AS revenue_paise,
        (AVG(EXTRACT(EPOCH FROM (ev.started_at - ev.booked_at)) / 60.0)
          FILTER (WHERE ev.started_at IS NOT NULL))::float8 AS avg_wait_minutes
      FROM ev
      JOIN doctors doc ON doc.id = ev.doctor_id
      GROUP BY ev.doctor_id, doc.name
      ORDER BY bookings DESC, doc.name ASC
    `);
    return rows.map((r) => ({
      doctorId: r.doctor_id,
      name: r.name,
      bookings: r.bookings,
      completed: r.completed,
      sessions: r.sessions,
      avgConsultsPerSession:
        r.sessions > 0 ? round1(r.completed / r.sessions) : 0,
      revenuePaise: Math.round(r.revenue_paise),
      avgWaitMinutes: Math.round(r.avg_wait_minutes ?? 0),
    }));
  }

  private async peakHours(
    clinicIds: string[],
    from: string | null,
    to: string | null,
  ): Promise<ReportPeakHour[]> {
    const ev = this.events(clinicIds, from, to);
    const rows = await this.prisma.$queryRaw<{ hour: number; total: number }[]>(
      Prisma.sql`
        WITH ev AS (${ev})
        SELECT EXTRACT(HOUR FROM booked_at)::int AS hour, COUNT(*)::int AS total
        FROM ev
        GROUP BY 1
        ORDER BY 1
      `,
    );
    return rows.map((r) => ({ hour: r.hour, total: r.total }));
  }

  /**
   * Raw booking rows for the range, newest first — the CSV export payload.
   * Same UNION source as the metrics so the export reconciles with the cards.
   */
  async exportRows(
    clinicIds: string[],
    from: string | null,
    to: string | null,
  ): Promise<
    {
      session_date: Date;
      doctor_name: string;
      source: string;
      status: string;
      token: string | null;
      session_type: string;
      revenue_paise: number;
      booked_at: Date;
      started_at: Date | null;
    }[]
  > {
    const ev = this.events(clinicIds, from, to);
    return this.prisma.$queryRaw(Prisma.sql`
      WITH ev AS (${ev})
      SELECT
        ev.session_date,
        doc.name AS doctor_name,
        ev.source,
        ev.status,
        ev.token,
        ev.session_type,
        ev.revenue::float8 AS revenue_paise,
        ev.booked_at,
        ev.started_at
      FROM ev
      JOIN doctors doc ON doc.id = ev.doctor_id
      ORDER BY ev.booked_at DESC
    `);
  }

  // ─── Shared event source + filters ───

  /**
   * The unified booking-event subquery (live bookings + archived history),
   * TENANT-scoped to a clinic-id set and optionally date-bounded on the
   * operational session_date. BOTH halves of the UNION carry the same
   * `clinic_id IN (...)` filter so a hospital's report never crosses tenants.
   * Returned as a composable SQL fragment embedded via `WITH ev AS (...)`.
   */
  private events(
    clinicIds: string[],
    from: string | null,
    to: string | null,
  ): Prisma.Sql {
    // Empty set must not become `IN ()` (a SQL error) nor an unscoped match —
    // a sentinel that matches no real id keeps it scoped to zero rows.
    const ids = clinicIds.length ? clinicIds : ['__none__'];
    const inList = Prisma.join(ids);
    const live = this.dateBounds('b.session_date', from, to);
    const hist = this.dateBounds('h.session_date', from, to);
    return Prisma.sql`
      SELECT
        d.clinic_id AS clinic_id,
        b.doctor_id AS doctor_id,
        b.source::text AS source,
        b.status::text AS status,
        b.session_type::text AS session_type,
        b.session_date AS session_date,
        b.created_at AS booked_at,
        b.consultation_started_at AS started_at,
        b.token_number AS token,
        CASE WHEN p.status = 'SUCCESS' THEN p.amount ELSE 0 END AS revenue
      FROM bookings b
      JOIN doctors d ON d.id = b.doctor_id
      LEFT JOIN payments p ON p.id = b.payment_id
      WHERE d.clinic_id IN (${inList}) ${live}
      UNION ALL
      SELECT
        h.clinic_id,
        h.doctor_id,
        h.source::text,
        h.final_status::text,
        h.session_type::text,
        h.session_date,
        h.booked_at,
        h.consultation_started_at,
        h.token_number,
        CASE WHEN h.payment_status = 'SUCCESS' THEN COALESCE(h.payment_amount, 0) ELSE 0 END
      FROM booking_history h
      WHERE h.clinic_id IN (${inList}) ${hist}
    `;
  }

  /** AND-clauses bounding a date column; column name is an internal constant. */
  private dateBounds(col: string, from: string | null, to: string | null): Prisma.Sql {
    const parts: Prisma.Sql[] = [];
    if (from) parts.push(Prisma.sql`AND ${Prisma.raw(col)} >= ${from}::date`);
    if (to) parts.push(Prisma.sql`AND ${Prisma.raw(col)} <= ${to}::date`);
    return parts.length ? Prisma.join(parts, ' ') : Prisma.empty;
  }
}

/** Date -> YYYY-MM-DD (UTC, matching how @db.Date round-trips). */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
