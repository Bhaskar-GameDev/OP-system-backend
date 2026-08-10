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
import { SessionClaims } from '../auth/auth-token.service';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { TenantScopeGuard } from '../common/tenant/tenant-scope';
import { toCsv } from '../common/csv';
import { AuditAction, AuditService } from './audit.service';
import { AuditExportQuery, AuditQuery } from './dto/audit-query.dto';

// Must stay in step with the AuditAction union — CANNOT be a subset of it, or
// filtering by an action the trail actually records is rejected as invalid.
const ACTIONS: AuditAction[] = [
  'DONE',
  'NO_SHOW',
  'SKIP',
  'PRIORITY',
  'REINSERT',
  'CANCEL',
  'RESCHEDULE',
];
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

/** Column order of the CSV export. Stable — downstream sheets rely on it. */
const CSV_HEADER = [
  'recorded_at',
  'staff',
  'role',
  'action',
  'token',
  'patient',
  'doctor',
  'session_date',
  'session_type',
  'metadata',
];

/**
 * Read surface for the compliance trail. Staff/doctor only (never patients).
 * Scope is derived from the token inside AuditService — the caller cannot widen
 * it via the query. Read-only: there is deliberately no write/delete route here
 * (writes happen as a side effect of the audited /queue/* actions).
 */
@Controller('audit-log')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
@Roles('DOCTOR', 'STAFF', 'ADMIN')
export class AuditLogController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(
    @Req() req: AuthedRequest,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('action') action?: string,
    @Query('actorId') actorId?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    const actor = req.user as SessionClaims;
    const q: AuditQuery = {
      limit: this.parseLimit(limit),
      offset: this.parseOffset(offset),
      action: this.parseAction(action),
      actorId: actorId || undefined,
      dateFrom: this.parseDate('dateFrom', dateFrom),
      dateTo: this.parseDate('dateTo', dateTo),
    };
    return this.audit.query(actor, q);
  }

  /**
   * GET /audit-log/export?action&actorId&dateFrom&dateTo — the same rows the
   * list returns, as a CSV attachment, unpaginated over the requested range.
   * The caller supplies the range (the desk app derives day/week/month from the
   * clinic's local calendar); scope stays token-derived inside AuditService.
   */
  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="audit-log.csv"')
  async exportCsv(
    @Req() req: AuthedRequest,
    @Query('action') action?: string,
    @Query('actorId') actorId?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ): Promise<string> {
    const filters: AuditExportQuery = {
      action: this.parseAction(action),
      actorId: actorId || undefined,
      dateFrom: this.parseDate('dateFrom', dateFrom),
      dateTo: this.parseDate('dateTo', dateTo),
    };
    const entries = await this.audit.exportEntries(
      req.user as SessionClaims,
      filters,
    );
    return toCsv(
      CSV_HEADER,
      entries.map((e) => [
        e.timestamp,
        e.staffName ?? '',
        e.staffRole,
        e.action,
        e.token ?? '',
        e.patientName ?? '',
        e.doctorName ?? e.doctorId,
        e.sessionDate,
        e.sessionType,
        e.metadata ? JSON.stringify(e.metadata) : '',
      ]),
    );
  }

  private parseLimit(raw?: string): number {
    if (raw === undefined) return DEFAULT_LIMIT;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      throw new BadRequestException(`limit must be an integer 1..${MAX_LIMIT}`);
    }
    return n;
  }

  private parseOffset(raw?: string): number {
    if (raw === undefined) return 0;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw new BadRequestException('offset must be a non-negative integer');
    }
    return n;
  }

  private parseAction(raw?: string): AuditAction | undefined {
    if (!raw) return undefined;
    if (!ACTIONS.includes(raw as AuditAction)) {
      throw new BadRequestException(`action must be one of ${ACTIONS.join(', ')}`);
    }
    return raw as AuditAction;
  }

  private parseDate(field: string, raw?: string): Date | undefined {
    if (!raw) return undefined;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException(`${field} must be a valid date`);
    }
    return d;
  }
}
