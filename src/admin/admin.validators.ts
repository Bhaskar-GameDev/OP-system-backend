/**
 * Input validation for the admin surface.
 *
 * Pure functions, extracted from the tail of `admin.service.ts` so the service
 * reads as what it does rather than how it checks its arguments. Each throws the
 * HTTP exception the caller should see. Unchanged otherwise.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export function req(v: string | undefined, field: string): string {
  if (v === undefined || v.trim() === '') {
    throw new BadRequestException(`${field} is required`);
  }
  return v;
}

/** Consultation fee must be a positive integer (in rupees). */
export function positiveFee(v: number | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || v <= 0) {
    throw new BadRequestException('consultationFee must be a positive integer');
  }
  return v;
}

export function parseStartTime(v: string): string {
  if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) {
    throw new BadRequestException('startTime must be "HH:MM" (24h)');
  }
  return v;
}

export function parseMaxTokens(v: number): number {
  if (!Number.isInteger(v) || v <= 0) {
    throw new BadRequestException('maxTokens must be a positive integer');
  }
  return v;
}

export function parseDays(v: number[]): number[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new BadRequestException('daysOfWeek must be a non-empty array');
  }
  for (const d of v) {
    if (!Number.isInteger(d) || d < 0 || d > 6) {
      throw new BadRequestException('daysOfWeek entries must be integers 0–6 (Sun–Sat)');
    }
  }
  return [...new Set(v)].sort((a, b) => a - b);
}

export function notFoundIfMissing(e: unknown, message: string): unknown {
  if (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    e.code === 'P2025' // record not found
  ) {
    return new NotFoundException(message);
  }
  return e;
}
