/**
 * Reception check-in projection. Fresh object, explicit allow-list — no patient
 * PII or internal fields leak. arrived is derived: checkedInAt != null.
 */
export interface CheckInView {
  id: string;
  checkedInAt: string | null; // ISO8601, or null if not arrived
  arrived: boolean;
}

type BookingLike = { id: string; checkedInAt: Date | null };

export function toCheckInView(b: BookingLike): CheckInView {
  return {
    id: b.id,
    checkedInAt: b.checkedInAt ? b.checkedInAt.toISOString() : null,
    arrived: b.checkedInAt !== null,
  };
}

/** PATCH body: { arrived: true } to check in, { arrived: false } to clear. */
export interface CheckInInput {
  arrived: boolean;
}

/**
 * Reception booking-roster projection — one row of the check-in roster for a
 * session: who is booked, their token, current status, and arrival. Staff-facing
 * allow-list — patient NAME only (no mobile/age/PII beyond the name the desk
 * needs to call them). arrived is derived: checkedInAt != null.
 */
export interface BookingRosterView {
  bookingId: string;
  tokenNumber: string | null;
  patientName: string;
  source: string;
  status: string;
  arrived: boolean;
  checkedInAt: string | null; // ISO8601, or null if not arrived
}

type RosterRow = {
  id: string;
  tokenNumber: string | null;
  source: string;
  status: string;
  checkedInAt: Date | null;
  patient: { name: string };
};

export function toBookingRosterView(b: RosterRow): BookingRosterView {
  return {
    bookingId: b.id,
    tokenNumber: b.tokenNumber,
    patientName: b.patient.name,
    source: b.source,
    status: b.status,
    arrived: b.checkedInAt !== null,
    checkedInAt: b.checkedInAt ? b.checkedInAt.toISOString() : null,
  };
}

/**
 * Reception doctor projection — the doctors in the caller's clinic, for the
 * queue-monitoring doctor picker. Staff-internal allow-list: NO username /
 * passwordHash. avgConsultMinutes is included because the queue view shows ETA.
 */
export interface ReceptionDoctorView {
  id: string;
  name: string;
  specialization: string | null;
  avgConsultMinutes: number;
}

type DoctorLike = {
  id: string;
  name: string;
  specialization: string | null;
  avgConsultMinutes: number;
};

export function toReceptionDoctorView(d: DoctorLike): ReceptionDoctorView {
  return {
    id: d.id,
    name: d.name,
    specialization: d.specialization,
    avgConsultMinutes: d.avgConsultMinutes,
  };
}

/**
 * Walk-in registration body. Patient identity (mobile + name) is captured at
 * the desk; the session locates the doctor/date/slot. No payment — walk-ins pay
 * at the desk, so there is no Razorpay flow here.
 */
export interface RegisterWalkInInput {
  mobile: string;
  name: string;
  doctorId: string;
  sessionDate: string; // 'YYYY-MM-DD'
  sessionType: "MORNING" | "EVENING";
}

/**
 * Result of a walk-in registration: a REAL Booking (with a real bookingId and
 * token) now in the live queue — identical lifecycle to an app booking, so
 * check-in / no-show / skip / priority / reinsert all work off this bookingId.
 */
export interface WalkInView {
  bookingId: string;
  patientId: string;
  tokenNumber: string;
  status: string; // BOOKED, or ACTIVE if it landed at rank 0
  doctorId: string;
  sessionDate: string;
  sessionType: string;
}
