import {
  Body,
  Controller,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { AuthedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { TenantScopeGuard } from '../common/tenant/tenant-scope';
import { TenantService } from '../common/tenant/tenant.service';
import { EncounterService } from './encounter.service';
import { RegisterEncounterDto } from './encounter.dto';

class ArriveBody {
  @IsOptional() @IsString() actorId?: string;
}

/**
 * OP registration surface (ARCHITECTURE.md §4). ONE endpoint for every staff-side
 * source — `source` travels in the body and is analytics-only; it never affects
 * the queue. Registration records intent: it does NOT issue a token and does NOT
 * enqueue (that is check-in + token + enqueue, deliberately separate).
 *
 * Tenant scope: the target doctor must be inside the caller's scope
 * (DOCTOR=own, STAFF=own clinic, ADMIN=own hospital) — enforced per request,
 * since the doctorId is request-supplied and must never be trusted.
 */
@Controller('op')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
@Roles('STAFF', 'ADMIN', 'DOCTOR')
export class OpRegistrationController {
  constructor(
    private readonly encounters: EncounterService,
    private readonly tenant: TenantService,
  ) {}

  /** POST /op/registrations — create an Encounter (REGISTERED). No token. */
  @Post('registrations')
  async register(@Req() req: AuthedRequest, @Body() dto: RegisterEncounterDto) {
    await this.tenant.assertQueueAccess(req.user, dto.doctorId);
    // Actor defaults to the authenticated principal (audit trail).
    return this.encounters.register({ ...dto, actorId: dto.actorId ?? req.user?.sub });
  }

  /** POST /op/encounters/:id/arrive — optional pre-check-in arrival marker. */
  @Post('encounters/:id/arrive')
  async arrive(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: ArriveBody,
  ) {
    await this.tenant.assertEncounterAccess(req.user, id);
    return this.encounters.arrive(id, body.actorId ?? req.user?.sub);
  }
}
