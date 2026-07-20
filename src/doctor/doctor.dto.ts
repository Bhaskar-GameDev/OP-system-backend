import { BookingSource, BookingStatus, SessionType } from '@prisma/client';
import { EtaResult } from '../queue-engine/eta.service';

/** Friendly booking origin for the doctor UI. APP/VOICE = online, WALK_IN = desk. */
export type BookingType = 'ONLINE' | 'WALK_IN';

/**
 * One row of the doctor's live queue board: the live ordering + ETA (from the
 * Queue Engine) enriched with the booking facts a doctor needs — patient name,
 * origin, and lifecycle status. Front of queue (position 1) is the patient the
 * engine has promoted to ACTIVE, i.e. the one being / about to be seen.
 */
export interface DoctorQueueEntry {
  tokenNumber: string;
  position: number; // 1-based, front -> back
  patientsAhead: number;
  etaMinutes: number;
  patientName: string | null; // null for raw/unmapped tokens
  bookingId: string | null;
  source: BookingSource | null;
  bookingType: BookingType | null;
  status: BookingStatus | null;
  isActive: boolean; // front of queue (currently being served)
}

export interface DoctorQueueView {
  doctorId: string;
  sessionDate: string; // YYYY-MM-DD
  sessionType: SessionType;
  activeToken: string | null;
  total: number;
  entries: DoctorQueueEntry[];
}

export interface DoctorProfileView {
  id: string;
  name: string;
  specialization: string | null;
  clinicId: string;
  avgConsultMinutes: number;
}

/**
 * A completed consultation from today's session — these have left the live
 * queue, so the dashboard lists them separately to let the doctor add or edit
 * the note. `hasNote` drives the View/Edit affordance without a second fetch.
 */
export interface DoctorCompletedEntry {
  bookingId: string;
  tokenNumber: string | null;
  patientName: string | null;
  consultationEndedAt: string | null; // ISO
  hasNote: boolean;
}

export interface DoctorCompletedView {
  doctorId: string;
  sessionDate: string; // YYYY-MM-DD
  sessionType: SessionType;
  entries: DoctorCompletedEntry[];
}

/** Loose booking shape the service hands in (only the selected fields). */
type BookingFacts = {
  source: BookingSource;
  status: BookingStatus;
  patient: { name: string } | null;
} | null;

function bookingType(source: BookingSource | null): BookingType | null {
  if (source === null) return null;
  return source === BookingSource.WALK_IN ? 'WALK_IN' : 'ONLINE';
}

export function toDoctorQueueEntry(
  eta: EtaResult,
  bookingId: string | null,
  booking: BookingFacts,
): DoctorQueueEntry {
  const source = booking?.source ?? null;
  const name = booking?.patient?.name ?? null;
  return {
    tokenNumber: eta.tokenNumber,
    position: eta.position,
    patientsAhead: eta.patientsAhead,
    etaMinutes: eta.etaMinutes,
    patientName: name && name.length > 0 ? name : null,
    bookingId,
    source,
    bookingType: bookingType(source),
    status: booking?.status ?? null,
    isActive: eta.position === 1,
  };
}
