import {
  Body,
  Controller,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { CheckInMethod } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { AuthedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { TenantScopeGuard } from '../common/tenant/tenant-scope';
import { TenantService } from '../common/tenant/tenant.service';
import { CheckInService } from './checkin.service';

class CheckInBody {
  @IsOptional() @IsEnum(CheckInMethod) method?: CheckInMethod;
  // Reception combined path: also allocate the token immediately.
  @IsOptional() @IsBoolean() issueToken?: boolean;
}

/**
 * Check-in surface (ARCHITECTURE.md §3). Check-in is the GATE to token issuance;
 * an encounter that is not checked in can never enter a queue. Token issuance is
 * still a separate step unless `issueToken:true` is passed (reception combined
 * path), which composes the same primitives — it is not a fork.
 */
@Controller('op')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
@Roles('STAFF', 'ADMIN', 'DOCTOR')
export class OpCheckInController {
  constructor(
    private readonly checkIn: CheckInService,
    private readonly tenant: TenantService,
  ) {}

  /** POST /op/encounters/:id/check-in — confirm presence, optionally issue token. */
  @Post('encounters/:id/check-in')
  async doCheckIn(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: CheckInBody,
  ) {
    await this.tenant.assertEncounterAccess(req.user, id);
    return this.checkIn.checkIn(id, body.method ?? CheckInMethod.DESK, {
      checkedInBy: req.user?.sub,
      issueToken: body.issueToken ?? false,
    });
  }
}
