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
import { TenantScopeGuard } from '../common/tenant/tenant-scope';
import { AnalyticsService } from './analytics.service';
import { adminClinicId } from './admin-scope';

/**
 * Analytics read surface. ADMIN-only. Scope is the admin's OWN home clinic
 * (token.clinicId) — it is structurally tenant-isolated: the clinic id comes
 * from the token, never a param, so an admin can never read another clinic's
 * (or hospital's) analytics_daily rows. Hospital-wide aggregation lives in the
 * reports surface (/admin/reports). Serves precomputed analytics_daily rows
 * only — never scans bookings or booking_history at read time.
 */
@Controller('admin/analytics')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
@Roles('ADMIN')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /** GET /admin/analytics/daily?date=YYYY-MM-DD */
  @Get('daily')
  getDay(@Req() req: AuthedRequest, @Query('date') date?: string) {
    if (!date) throw new BadRequestException('date is required (YYYY-MM-DD)');
    return this.analytics.getDay(adminClinicId(req), parseDay(date));
  }

  /** GET /admin/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD (both optional). */
  @Get()
  getRange(
    @Req() req: AuthedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.getRange(
      adminClinicId(req),
      from ? parseDay(from) : undefined,
      to ? parseDay(to) : undefined,
    );
  }
}

/** Parse YYYY-MM-DD into a UTC-midnight Date matching @db.Date storage. */
function parseDay(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new BadRequestException('date must be YYYY-MM-DD');
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}
