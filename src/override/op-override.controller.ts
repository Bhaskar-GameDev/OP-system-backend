import {
  Body,
  Controller,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { OverrideReason } from '@prisma/client';
import {
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { AuthedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { TenantScopeGuard } from '../common/tenant/tenant-scope';
import { TenantService } from '../common/tenant/tenant.service';
import { DoctorOverrideService } from './doctor-override.service';
import { EmergencyService } from './emergency.service';

class OverrideStartBody {
  @IsString() doctorId!: string;
  @IsOptional() @IsString() patientId?: string;
  @IsOptional() @Matches(/^\d{10}$/, { message: 'mobile must be 10 digits' })
  mobile?: string;
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsISO8601() serviceDate!: string;
  @IsEnum(OverrideReason) reason!: OverrideReason;
}

class EmergencyStartBody {
  @IsString() doctorId!: string;
  @IsOptional() @IsString() patientId?: string;
  @IsOptional() @Matches(/^\d{10}$/, { message: 'mobile must be 10 digits' })
  mobile?: string;
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsISO8601() serviceDate!: string;
}

/**
 * Override + Emergency surfaces (ARCHITECTURE.md §7/§8). Both are first-class
 * workflows, NOT queue hacks: an override sends a specific patient in without
 * renumbering anyone; an emergency INTERRUPTS the room and resumes the prior
 * consultation. Neither touches the waiting queue's token order.
 */
@Controller('op')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
@Roles('DOCTOR', 'STAFF', 'ADMIN')
export class OpOverrideController {
  constructor(
    private readonly override: DoctorOverrideService,
    private readonly emergency: EmergencyService,
    private readonly tenant: TenantService,
  ) {}

  /** POST /op/override/start — send a specific patient in (no renumbering). */
  @Post('override/start')
  async overrideStart(
    @Req() req: AuthedRequest,
    @Body() body: OverrideStartBody,
  ) {
    await this.tenant.assertQueueAccess(req.user, body.doctorId);
    return this.override.start({ ...body, actorId: req.user?.sub });
  }

  /** POST /op/override/:encounterId/complete — finish an override consultation. */
  @Post('override/:encounterId/complete')
  async overrideComplete(
    @Req() req: AuthedRequest,
    @Param('encounterId') encounterId: string,
  ) {
    await this.tenant.assertEncounterAccess(req.user, encounterId);
    return this.override.complete(encounterId, { actorId: req.user?.sub });
  }

  /** POST /op/emergency/start — interrupt the room for an emergency. */
  @Post('emergency/start')
  async emergencyStart(
    @Req() req: AuthedRequest,
    @Body() body: EmergencyStartBody,
  ) {
    await this.tenant.assertQueueAccess(req.user, body.doctorId);
    return this.emergency.start({ ...body, actorId: req.user?.sub });
  }

  /** POST /op/emergency/:consultationId/end — end emergency, resume prior. */
  @Post('emergency/:consultationId/end')
  async emergencyEnd(
    @Req() req: AuthedRequest,
    @Param('consultationId') consultationId: string,
  ) {
    await this.tenant.assertConsultationAccess(req.user, consultationId);
    return this.emergency.end(consultationId, { actorId: req.user?.sub });
  }
}
