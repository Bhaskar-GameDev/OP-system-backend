/**
 * Operational reporting contracts (admin/staff analytics dashboard).
 *
 * Distinct from admin.dto's AnalyticsDailyView (the precomputed analytics_daily
 * rollup): these are computed on demand by SQL aggregation over the live
 * `bookings` table UNION the archived `booking_history`, so a report spanning a
 * date range is correct whether or not the archival sweep has run yet.
 *
 * All money is in PAISE (integer), matching how payments.amount is stored.
 */

export type ReportBucket = 'day' | 'week' | 'month';

export interface ReportTotals {
  total: number; // all bookings in range
  online: number; // source APP or VOICE
  walkIn: number; // source WALK_IN
  completed: number;
  noShows: number;
  revenuePaise: number; // sum of SUCCESS payments
  avgWaitMinutes: number; // booked -> consultation start, completed/seen rows
}

export interface ReportTrendPoint {
  bucket: string; // YYYY-MM-DD (start of day/week/month)
  total: number;
  online: number;
  walkIn: number;
  revenuePaise: number;
}

export interface ReportDoctorStat {
  doctorId: string;
  name: string;
  bookings: number;
  completed: number;
  sessions: number; // distinct (date, session type) the doctor worked
  avgConsultsPerSession: number; // completed / sessions
  revenuePaise: number;
  avgWaitMinutes: number;
}

export interface ReportPeakHour {
  hour: number; // 0–23, from booking creation time
  total: number;
}

export interface ReportSummary {
  range: { from: string | null; to: string | null; bucket: ReportBucket };
  totals: ReportTotals;
  trend: ReportTrendPoint[];
  doctors: ReportDoctorStat[]; // busiest first
  peakHours: ReportPeakHour[];
}
