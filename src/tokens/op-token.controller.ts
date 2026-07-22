import { Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { TenantScopeGuard } from '../common/tenant/tenant-scope';
import { TenantService } from '../common/tenant/tenant.service';
import { TokenSeriesService } from './token-series.service';

/**
 * Token issuance surface (ARCHITECTURE.md §5). A token is issued only AFTER
 * check-in (the state machine forbids ISSUE_TOKEN before CHECKED_IN). Payment
 * never gates this. Idempotent per encounter.
 */
@Controller('op')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
@Roles('STAFF', 'ADMIN', 'DOCTOR')
export class OpTokenController {
  constructor(
    private readonly tokens: TokenSeriesService,
    private readonly tenant: TenantService,
  ) {}

  /** POST /op/encounters/:id/token — issue this encounter's token. */
  @Post('encounters/:id/token')
  async issue(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.tenant.assertEncounterAccess(req.user, id);
    return this.tokens.issueForEncounter(id, req.user?.sub);
  }
}
