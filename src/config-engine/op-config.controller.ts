import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Allow, IsIn, IsString } from 'class-validator';
import { AuthedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import {
  TenantScopeGuard,
  tenantHospitalId,
} from '../common/tenant/tenant-scope';
import { TenantService } from '../common/tenant/tenant.service';
import { ConfigScopeType, OpConfigService } from './op-config.service';

class SetConfigBody {
  @IsIn(['HOSPITAL', 'CLINIC', 'DOCTOR']) scopeType!: ConfigScopeType;
  @IsString() scopeId!: string;
  @IsString() key!: string;
  // value is intentionally untyped — config is schemaless per key. @Allow keeps
  // it from being stripped by the global whitelisting ValidationPipe.
  @Allow() value!: unknown;
}

/**
 * Config surface (ARCHITECTURE.md §2, config engine). Everything the engine does
 * is config-driven; this is the ADMIN write/read seam. Writes are scoped and
 * every change emits ConfigChanged (audit). Reads resolve most-specific-first
 * (DOCTOR > CLINIC > HOSPITAL).
 */
@Controller('op')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
@Roles('ADMIN')
export class OpConfigController {
  constructor(
    private readonly config: OpConfigService,
    private readonly tenant: TenantService,
  ) {}

  /** GET /op/config?key=&clinicId=&doctorId= — resolved value for a scope. */
  @Get('config')
  async read(
    @Req() req: AuthedRequest,
    @Query('key') key: string,
    @Query('clinicId') clinicId?: string,
    @Query('doctorId') doctorId?: string,
  ) {
    if (!key) throw new BadRequestException('key is required');
    const hospitalId = tenantHospitalId(req);
    if (clinicId) await this.tenant.assertClinicInHospital(hospitalId, clinicId);
    if (doctorId) await this.tenant.assertDoctorInHospital(hospitalId, doctorId);
    const value = await this.config.get<unknown>(
      key,
      { hospitalId, clinicId, doctorId },
      null,
    );
    return { key, value };
  }

  /** PUT /op/config — set a scoped config value. */
  @Put('config')
  async write(@Req() req: AuthedRequest, @Body() body: SetConfigBody) {
    const hospitalId = tenantHospitalId(req);
    await this.assertScopeInTenant(hospitalId, body.scopeType, body.scopeId);
    await this.config.set(
      body.scopeType,
      body.scopeId,
      body.key,
      body.value,
      req.user?.sub,
    );
    return { ok: true };
  }

  private async assertScopeInTenant(
    hospitalId: string,
    scopeType: ConfigScopeType,
    scopeId: string,
  ): Promise<void> {
    switch (scopeType) {
      case 'HOSPITAL':
        if (scopeId !== hospitalId) {
          throw new ForbiddenException('cannot configure another hospital');
        }
        return;
      case 'CLINIC':
        await this.tenant.assertClinicInHospital(hospitalId, scopeId);
        return;
      case 'DOCTOR':
        await this.tenant.assertDoctorInHospital(hospitalId, scopeId);
        return;
      default:
        throw new BadRequestException('invalid scopeType');
    }
  }
}
