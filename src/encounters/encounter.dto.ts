import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
} from 'class-validator';
import { RegistrationReason, RegistrationSource } from '@prisma/client';

/**
 * Unified registration input (ARCHITECTURE.md §4). Every source (APP,
 * VOICE_AGENT, RECEPTION) uses this SAME shape and produces the SAME Encounter.
 * `source` is recorded for analytics/audit only and never reaches the queue.
 */
export class RegisterEncounterDto {
  // Patient: either an existing id, or contact details to upsert by mobile.
  @IsOptional() @IsString() patientId?: string;

  @IsOptional()
  @Matches(/^\d{10}$/, { message: 'mobile must be 10 digits' })
  mobile?: string;

  @IsOptional() @IsString() @Length(1, 120) name?: string;

  @IsString() doctorId!: string;

  // The DAY the patient is expected — a date, never a time slot.
  @IsISO8601() serviceDate!: string;

  @IsEnum(RegistrationSource) source!: RegistrationSource;

  @IsOptional() @IsEnum(RegistrationReason) reason?: RegistrationReason;

  // TokenSeries id (OP category). Optional — falls back to the clinic default.
  @IsOptional() @IsString() opCategoryId?: string;

  @IsOptional() @IsString() actorId?: string;

  @IsOptional() @IsString() departmentId?: string;

  // Free-form channel context: {callSid, deviceId, deskId, language, …}.
  @IsOptional() channelMeta?: Record<string, unknown>;

  // Idempotency (voice retries a dropped call): same key -> same Encounter.
  @IsOptional() @IsString() idempotencyKey?: string;
}

export class ArriveDto {
  @IsString() encounterId!: string;
  @IsOptional() @IsString() actorId?: string;
}
