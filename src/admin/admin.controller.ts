import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AdminService } from './admin.service';
import { adminClinicId, assertClinicMatch } from './admin-scope';
import {
  CreateDoctorInput,
  CreateStaffInput,
  UpdateClinicInput,
  UpdateDoctorInput,
  UpdateStaffInput,
} from './admin.dto';

/** Body shapes that MAY echo a clinicId — only ever used to confirm scope. */
type WithClinic = { clinicId?: string };

/**
 * Admin Portal. ADMIN-only. Every handler scopes to the admin's OWN clinic via
 * the token (`adminClinicId`); a clinicId appearing in the body is only checked
 * for a match (assertClinicMatch -> 403 on mismatch). No clinic-creation route
 * exists — onboarding is a seed script; clinic management is edit-only.
 */
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  // ─── Clinic (edit-only) ───

  @Get('clinic')
  getClinic(@Req() req: AuthedRequest) {
    return this.admin.getClinic(adminClinicId(req));
  }

  @Patch('clinic')
  updateClinic(@Req() req: AuthedRequest, @Body() body: UpdateClinicInput & WithClinic) {
    const clinicId = adminClinicId(req);
    assertClinicMatch(clinicId, body.clinicId);
    return this.admin.updateClinic(clinicId, body);
  }

  // ─── Doctors ───

  @Get('doctors')
  listDoctors(@Req() req: AuthedRequest) {
    return this.admin.listDoctors(adminClinicId(req));
  }

  @Get('doctors/:id')
  getDoctor(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.admin.getDoctor(adminClinicId(req), id);
  }

  @Post('doctors')
  createDoctor(@Req() req: AuthedRequest, @Body() body: CreateDoctorInput & WithClinic) {
    const clinicId = adminClinicId(req);
    assertClinicMatch(clinicId, body.clinicId);
    return this.admin.createDoctor(clinicId, body);
  }

  @Patch('doctors/:id')
  updateDoctor(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateDoctorInput & WithClinic,
  ) {
    const clinicId = adminClinicId(req);
    assertClinicMatch(clinicId, body.clinicId);
    return this.admin.updateDoctor(clinicId, id, body);
  }

  @Delete('doctors/:id')
  @HttpCode(204)
  deleteDoctor(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.admin.deleteDoctor(adminClinicId(req), id);
  }

  // ─── Staff ───

  @Get('staff')
  listStaff(@Req() req: AuthedRequest) {
    return this.admin.listStaff(adminClinicId(req));
  }

  @Get('staff/:id')
  getStaff(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.admin.getStaff(adminClinicId(req), id);
  }

  @Post('staff')
  createStaff(@Req() req: AuthedRequest, @Body() body: CreateStaffInput & WithClinic) {
    const clinicId = adminClinicId(req);
    assertClinicMatch(clinicId, body.clinicId);
    return this.admin.createStaff(clinicId, body);
  }

  @Patch('staff/:id')
  updateStaff(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateStaffInput & WithClinic,
  ) {
    const clinicId = adminClinicId(req);
    assertClinicMatch(clinicId, body.clinicId);
    return this.admin.updateStaff(clinicId, id, body);
  }

  @Delete('staff/:id')
  @HttpCode(204)
  deleteStaff(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.admin.deleteStaff(adminClinicId(req), id);
  }
}
