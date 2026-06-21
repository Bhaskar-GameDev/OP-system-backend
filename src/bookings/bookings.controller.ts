import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { BookingsService } from './bookings.service';

/**
 * A patient's own booking history. PATIENT-only; the patient id comes from the
 * JWT `sub` — a patient can only ever read their own bookings.
 */
@Controller('me/bookings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('PATIENT')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Get('upcoming')
  upcoming(
    @Req() req: AuthedRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.bookings.upcoming(patientId(req), toInt(page), toInt(pageSize));
  }

  @Get('past')
  past(
    @Req() req: AuthedRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.bookings.past(patientId(req), toInt(page), toInt(pageSize));
  }
}

function patientId(req: AuthedRequest): string {
  const sub = req.user?.sub;
  if (!sub) throw new BadRequestException('missing patient identity');
  return sub;
}

function toInt(v?: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
