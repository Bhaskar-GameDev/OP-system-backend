import type { SessionType } from '@prisma/client';
import type { AuditAction } from '../audit.service';

/**
 * Parsed/validated query for GET /audit-log. All filters optional; scope
 * (clinic vs doctor) is derived from the caller's token, never the query.
 */
export interface AuditQuery {
  limit: number; // 1..100
  offset: number; // >= 0
  action?: AuditAction;
  actorId?: string; // staff/doctor filter
  dateFrom?: Date; // inclusive, on createdAt
  dateTo?: Date; // exclusive upper bound, on createdAt
}

/** One audit row, enriched with the names the desk needs to read it. */
export interface AuditLogView {
  id: string;
  timestamp: string; // ISO — when the action was recorded
  staffName: string | null; // resolved from actorId; null if no longer found
  staffRole: string; // actorRole as recorded
  action: AuditAction;
  token: string | null;
  patientName: string | null; // via bookingId, when the action targets a booking
  doctorId: string;
  doctorName: string | null;
  sessionDate: string; // YYYY-MM-DD
  sessionType: SessionType;
  metadata: Record<string, unknown> | null;
}

export interface AuditLogPage {
  entries: AuditLogView[];
  total: number;
  limit: number;
  offset: number;
}
