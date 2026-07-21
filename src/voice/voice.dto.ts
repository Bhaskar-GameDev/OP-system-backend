import { SessionType } from '@prisma/client';

/**
 * Wire contract for the `/voice/*` API, mirroring exactly what the voice agent
 * (`voice assistant/src/booking/bookingEngine.ts`) sends and expects. Keep these
 * shapes in lockstep with the agent — the contract test pins them.
 */

// ── /voice/availability ──
export interface VoiceAvailabilityRequest {
  didNumber: string;
  specialty?: string;
  sessionDate?: string; // ignored beyond today — same-day model resolves "now"
  sessionType?: SessionType;
}
export interface VoiceDoctorAvailability {
  doctorId: string;
  doctorName: string;
  specialization: string | null;
  consultationFee: number;
  sessions: Array<{ sessionType: SessionType; waiting: number; etaMinutes: number }>;
}
export interface VoiceAvailabilityResponse {
  clinicId: string;
  clinicName: string;
  /**
   * Clinic's public number, so the agent can hand a caller somewhere real when
   * asked for a human. Null when the clinic has none on file.
   */
  clinicContactNumber: string | null;
  sessionDate: string;
  doctors: VoiceDoctorAvailability[];
}

// ── /voice/bookings ──
export interface VoiceBookingRequest {
  didNumber: string;
  doctorId: string;
  sessionDate?: string;
  sessionType: SessionType;
  patientPhone: string;
  patientName?: string;
  callSid: string;
  language?: string;
}
export interface VoiceBookingResult {
  bookingId: string;
  tokenNumber: string;
  doctorId: string;
  doctorName: string;
  sessionDate: string;
  sessionType: SessionType;
  status: string;
}

// ── /voice/appointments/lookup ──
export interface VoiceLookupRequest {
  didNumber: string;
  patientPhone: string;
}
export interface VoiceAppointmentRecord {
  appointmentId: string;
  doctorId: string;
  doctorName: string;
  specialization: string | null;
  sessionDate: string;
  sessionType: SessionType;
  tokenNumber: string | null;
  status: string;
}

// ── /voice/appointments/cancel ──
export interface VoiceCancelRequest {
  appointmentId: string;
}

// ── /voice/queue-status ──
export interface VoiceQueueStatusRequest {
  didNumber: string;
  patientPhone: string;
}
/**
 * Live position for one of the caller's own tokens. Everything here is meant to
 * be read aloud, so it is pre-derived rather than raw: the agent should never
 * have to compute a wait from a queue listing mid-call.
 */
export interface VoiceQueueStatusRecord {
  bookingId: string;
  tokenNumber: string;
  doctorName: string;
  specialization: string | null;
  sessionType: SessionType;
  /** People strictly ahead of this token right now. 0 = they are being seen. */
  patientsAhead: number;
  estimatedWaitMinutes: number;
  /** Token at the front of that doctor's queue, or null if the queue is empty. */
  currentlyServing: string | null;
}

// ── /voice/call-logs ──
export interface VoiceCallLogRequest {
  callSid: string;
  didNumber?: string;
  callerPhone?: string;
  language?: string | null;
  transcript?: unknown;
  slots?: unknown;
  bookingId?: string | null;
  outcome?: string | null;
  duration?: number | null;
}
