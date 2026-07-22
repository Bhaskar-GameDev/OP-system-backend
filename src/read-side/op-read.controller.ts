import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { TenantScopeGuard, tenantHospitalId } from '../common/tenant/tenant-scope';
import { TenantService } from '../common/tenant/tenant.service';
import { QueueReadService } from './queue-read.service';

/**
 * Read models (ARCHITECTURE.md §9, CQRS read side). All served from the
 * projected QueueReadModel — never by replaying events on the request path.
 * Every read is tenant-scoped to the caller.
 */
@Controller('op')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
@Roles('DOCTOR', 'STAFF', 'ADMIN')
export class OpReadController {
  constructor(
    private readonly reads: QueueReadService,
    private readonly tenant: TenantService,
  ) {}

  /** GET /op/doctors/:id/dashboard — active + waiting for a doctor. */
  @Get('doctors/:id/dashboard')
  async doctorDashboard(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.tenant.assertQueueAccess(req.user, id);
    return this.reads.doctorDashboard(id);
  }

  /** GET /op/clinics/:id/roster — everyone in the clinic today, by status. */
  @Get('clinics/:id/roster')
  async clinicRoster(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.tenant.assertClinicInHospital(tenantHospitalId(req), id);
    // STAFF is bound to their home clinic; ADMIN may read any clinic in-tenant.
    if (req.user?.role === 'STAFF' && req.user.clinicId !== id) {
      throw new ForbiddenException('clinic belongs to another desk');
    }
    return this.reads.receptionRoster(id);
  }

  /** GET /op/sessions/:id/display — public display board (now serving + next). */
  @Get('sessions/:id/display')
  async displayBoard(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Query('take') take?: string,
  ) {
    await this.tenant.assertSessionAccess(req.user, id);
    const n = take ? Math.max(1, Math.min(20, parseInt(take, 10) || 5)) : 5;
    return this.reads.displayBoard(id, n);
  }

  /** GET /op/encounters/:id/tracking — a single patient's live position. */
  @Get('encounters/:id/tracking')
  async patientTracking(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.tenant.assertEncounterAccess(req.user, id);
    return this.reads.patientTracking(id);
  }
}
