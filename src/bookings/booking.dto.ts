import {
  BookingSource,
  BookingStatus,
  PaymentStatus,
  SessionType,
} from '@prisma/client';

/**
 * Public projection for a patient's own bookings (live or archived). Same
 * discipline as Discovery: fresh object, explicit allow-list, never a spread of
 * a raw model — no internal/auth fields can reach the wire.
 */
export interface PublicBooking {
  id: string;
  doctorId: string;
  doctorName: string | null;
  source: BookingSource;
  tokenNumber: string | null;
  sessionDate: string; // YYYY-MM-DD
  sessionType: SessionType;
  status: BookingStatus;
  paymentStatus: PaymentStatus | null;
  consultationStartedAt: string | null;
  consultationEndedAt: string | null;
  createdAt: string; // ISO
  archived: boolean; // true if sourced from booking_history
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

// Loose inputs: a full model may be handed in; only safe keys are read.
type LiveBooking = {
  id: string;
  doctorId: string;
  source: BookingSource;
  tokenNumber: string | null;
  sessionDate: Date;
  sessionType: SessionType;
  status: BookingStatus;
  consultationStartedAt: Date | null;
  consultationEndedAt: Date | null;
  createdAt: Date;
  payment?: { status: PaymentStatus } | null;
};

type HistoryBooking = {
  bookingId: string;
  doctorId: string;
  source: BookingSource;
  tokenNumber: string | null;
  sessionDate: Date;
  sessionType: SessionType;
  finalStatus: BookingStatus;
  paymentStatus: PaymentStatus | null;
  consultationStartedAt: Date | null;
  consultationEndedAt: Date | null;
  bookedAt: Date;
};

export function toPublicFromLive(b: LiveBooking, doctorName: string | null): PublicBooking {
  return {
    id: b.id,
    doctorId: b.doctorId,
    doctorName,
    source: b.source,
    tokenNumber: b.tokenNumber,
    sessionDate: isoDate(b.sessionDate),
    sessionType: b.sessionType,
    status: b.status,
    paymentStatus: b.payment?.status ?? null,
    consultationStartedAt: iso(b.consultationStartedAt),
    consultationEndedAt: iso(b.consultationEndedAt),
    createdAt: iso(b.createdAt) as string,
    archived: false,
  };
}

export function toPublicFromHistory(h: HistoryBooking, doctorName: string | null): PublicBooking {
  return {
    id: h.bookingId,
    doctorId: h.doctorId,
    doctorName,
    source: h.source,
    tokenNumber: h.tokenNumber,
    sessionDate: isoDate(h.sessionDate),
    sessionType: h.sessionType,
    status: h.finalStatus,
    paymentStatus: h.paymentStatus,
    consultationStartedAt: iso(h.consultationStartedAt),
    consultationEndedAt: iso(h.consultationEndedAt),
    createdAt: iso(h.bookedAt) as string,
    archived: true,
  };
}
