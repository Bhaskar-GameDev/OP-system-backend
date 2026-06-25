import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';
import type { SessionType } from '@prisma/client';

const SESSION_TYPES = ['MORNING', 'EVENING'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── Inbound DTOs (validated; ValidationPipe whitelists unknown fields) ──────

export class SearchAvailabilityDto {
  @IsOptional() @IsString()
  didNumber?: string; // dialed DID — resolves the clinic; falls back to default

  @IsString() @MinLength(2)
  specialty!: string; // canonical or colloquial term ("dermatology", "skin doctor")

  @Matches(DATE_RE, { message: 'sessionDate must be YYYY-MM-DD' })
  sessionDate!: string;

  @IsOptional() @IsIn(SESSION_TYPES)
  sessionType?: SessionType; // MORNING | EVENING; omit to see both
}

export class BookDto {
  @IsOptional() @IsString()
  didNumber?: string;

  @IsString()
  doctorId!: string;

  @Matches(DATE_RE, { message: 'sessionDate must be YYYY-MM-DD' })
  sessionDate!: string;

  @IsIn(SESSION_TYPES)
  sessionType!: SessionType;

  @IsString() @MinLength(6)
  patientPhone!: string;

  @IsOptional() @IsString()
  patientName?: string;

  @IsOptional() @IsString()
  callSid?: string;

  @IsOptional() @IsString()
  language?: string;
}

export class LookupAppointmentsDto {
  @IsOptional() @IsString()
  didNumber?: string;

  @IsString() @MinLength(6)
  patientPhone!: string;
}

export class CancelAppointmentDto {
  @IsString()
  appointmentId!: string;
}

export class CallLogDto {
  @IsString()
  callSid!: string;

  @IsOptional() @IsString()
  didNumber?: string;

  @IsString()
  callerPhone!: string;

  @IsOptional() @IsString()
  language?: string;

  @IsOptional()
  transcript?: unknown; // array of { role, text, ts }

  @IsOptional()
  slots?: unknown;

  @IsOptional() @IsString()
  bookingId?: string;

  @IsOptional() @IsString()
  outcome?: string;

  @IsOptional()
  duration?: number;
}

// ─── Outbound view models ────────────────────────────────────────────────────

export interface SessionAvailabilityView {
  sessionType: SessionType;
  waiting: number; // patients currently in the live queue for this session
  etaMinutes: number; // waiting * doctor.avgConsultMinutes
}

export interface DoctorAvailabilityView {
  doctorId: string;
  doctorName: string;
  specialization: string | null;
  consultationFee: number;
  sessions: SessionAvailabilityView[];
}

export interface VoiceBookingView {
  bookingId: string;
  tokenNumber: string;
  doctorId: string;
  doctorName: string;
  sessionDate: string;
  sessionType: SessionType;
  status: string;
}

export interface VoiceAppointmentView {
  appointmentId: string;
  doctorId: string;
  doctorName: string;
  specialization: string | null;
  sessionDate: string;
  sessionType: SessionType;
  tokenNumber: string | null;
  status: string;
}
