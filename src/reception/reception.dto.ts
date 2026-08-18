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
  // Payment settle state — relevant to every "pay-at-desk" token (voice AND
  // walk-in) the desk collects on arrival. paid = an attached Payment at status
  // SUCCESS. amountDuePaise is what the desk should ask for (or, once paid, what
  // was actually taken); paidMode names HOW it was settled, so a cash drawer and
  // a waiver are never indistinguishable on the roster.
  payAtDesk: boolean;
  paid: boolean;
  amountDuePaise: number;
  paidMode: string | null; // CASH | UPI_DESK | CORPORATE_BILL | WAIVED | ONLINE
}

type RosterRow = {
  id: string;
  tokenNumber: string | null;
  source: string;
  status: string;
  checkedInAt: Date | null;
  payAtDesk: boolean;
  payment: { status: string; amount: number; deskMode: string | null } | null;
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
    payAtDesk: b.payAtDesk,
    paid: b.payment?.status === 'SUCCESS',
    amountDuePaise: b.payment?.amount ?? 0,
    paidMode: b.payment?.status === 'SUCCESS' ? b.payment.deskMode : null,
  };
}

/**
 * How the desk settled: the OpPaymentMode subset reception can take in person.
 * ONLINE is deliberately absent — that is the app's Razorpay path, never a desk
 * action, so it cannot be claimed by a click at the counter.
 */
export type DeskPaymentMode =
  | 'CASH'
  | 'UPI_DESK'
  | 'CORPORATE_BILL'
  | 'WAIVED';

export const DESK_PAYMENT_MODES: DeskPaymentMode[] = [
  'CASH',
  'UPI_DESK',
  'CORPORATE_BILL',
  'WAIVED',
];

/**
 * Desk collection body. Both fields optional so older reception clients (which
 * post an empty body) keep working — they settle CASH at the full amount due,
 * exactly the old behaviour. amountPaise covers concessions/part payment; WAIVED
 * always settles 0 whatever is sent.
 */
export interface CollectPaymentInput {
  mode?: DeskPaymentMode;
  amountPaise?: number;
}

/** Result of a desk payment collection. */
export interface CollectPaymentView {
  bookingId: string;
  paid: boolean;
  amountPaise: number;
  mode: DeskPaymentMode;
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
  /**
   * The name ON RECORD for this mobile — not necessarily the name the desk
   * typed. An existing patient keeps their stored name, so the desk must see
   * which record the token was actually issued against.
   */
  patientName: string | null;
  /** True when the desk typed a name that differs from the stored one. */
  nameMismatch: boolean;
  tokenNumber: string;
  status: string; // BOOKED, or ACTIVE if it landed at rank 0
  doctorId: string;
  sessionDate: string;
  sessionType: string;
}
