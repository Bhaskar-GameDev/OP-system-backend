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
