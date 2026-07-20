import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { adminClinicId } from './admin-scope';
import { TenantScopeGuard, tenantHospitalId } from '../common/tenant/tenant-scope';
import { TenantService } from '../common/tenant/tenant.service';
import { ReportsService } from './reports.service';
import { ReportBucket } from './reports.dto';

/**
 * Operational reporting surface. ADMIN sees their whole HOSPITAL (every clinic
 * under their hospitalId); STAFF sees only their own clinic. The clinic-id set is
 * derived from the token, never a request param. Date range (`from`/`to`,
 * inclusive, YYYY-MM-DD) is optional on every endpoint — omitted means all time.
 */
@Controller('admin/reports')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
@Roles('ADMIN', 'STAFF')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly tenant: TenantService,
  ) {}

  /**
   * The set of clinic ids the caller may report over. ADMIN -> all clinics in
   * the hospital; STAFF -> just their own clinic. Both are bounded by the token.
   */
  private async scopeClinicIds(req: AuthedRequest): Promise<string[]> {
    if (req.user?.role === 'ADMIN') {
      return this.tenant.clinicIdsForHospital(tenantHospitalId(req));
    }
    return [adminClinicId(req)]; // STAFF — own clinic
  }

  /** GET /admin/reports/summary?from&to&bucket — all dashboard metrics. */
  @Get('summary')
  async getSummary(
    @Req() req: AuthedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('bucket') bucket?: string,
  ) {
    return this.reports.getSummary(
      await this.scopeClinicIds(req),
      validDay(from, 'from'),
      validDay(to, 'to'),
      parseBucket(bucket),
    );
  }

  /** GET /admin/reports/export?from&to — raw booking rows as a CSV download. */
  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="bookings.csv"')
  async exportCsv(
    @Req() req: AuthedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<string> {
    const rows = await this.reports.exportRows(
      await this.scopeClinicIds(req),
      validDay(from, 'from'),
      validDay(to, 'to'),
    );
    const header = [
      'session_date',
      'doctor',
      'source',
      'status',
      'token',
      'session_type',
      'amount_rupees',
      'booked_at',
      'consultation_started_at',
    ];
    const lines = rows.map((r) =>
      [
        ymd(r.session_date),
        r.doctor_name,
        r.source,
        r.status,
        r.token ?? '',
        r.session_type,
        (Math.round(r.revenue_paise) / 100).toFixed(2),
        iso(r.booked_at),
        iso(r.started_at),
      ]
        .map(csvCell)
        .join(','),
    );
    return [header.join(','), ...lines].join('\r\n');
  }
}

/** Validate an optional YYYY-MM-DD param; returns null when absent. */
function validDay(s: string | undefined, field: string): string | null {
  if (s === undefined || s === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new BadRequestException(`${field} must be YYYY-MM-DD`);
  }
  return s;
}

function parseBucket(b: string | undefined): ReportBucket {
  if (b === undefined || b === '') return 'day';
  if (b === 'day' || b === 'week' || b === 'month') return b;
  throw new BadRequestException('bucket must be day, week or month');
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function iso(d: Date | null): string {
  return d ? d.toISOString() : '';
}

/** RFC-4180 quoting: wrap in quotes and double embedded quotes when needed. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
