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
import { TenantScopeGuard, tenantHospitalId } from '../common/tenant/tenant-scope';
import {
  CreateClinicInput,
  CreateDoctorInput,
  CreateDoctorSessionInput,
  CreateStaffInput,
  UpdateClinicInput,
  UpdateDoctorInput,
  UpdateDoctorSessionInput,
  UpdateStaffInput,
} from './admin.dto';

/** Body shapes that MAY echo a clinicId — only ever used to confirm scope. */
type WithClinic = { clinicId?: string };

/**
 * Admin Portal. ADMIN-only. Doctor/staff/session handlers scope to the admin's
 * OWN clinic via the token (`adminClinicId`); a clinicId echoed in the body is
 * only checked for a match (assertClinicMatch -> 403 on mismatch). The plural
 * `clinics` routes are a super-admin onboarding surface (create/list any clinic);
 * the singular `clinic` route edits the caller's own clinic.
 */
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
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

  // ─── Clinics (super-admin: onboarding new clinics) ───

  @Get('clinics')
  listClinics(@Req() req: AuthedRequest) {
    return this.admin.listClinics(tenantHospitalId(req));
  }

  @Get('clinics/:id')
  getClinicById(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.admin.getClinicById(tenantHospitalId(req), id);
  }

  @Post('clinics')
  createClinic(@Req() req: AuthedRequest, @Body() body: CreateClinicInput) {
    return this.admin.createClinic(tenantHospitalId(req), body);
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

  // ─── Doctor session schedule (nested under a doctor) ───

  @Get('doctors/:id/sessions')
  listSessions(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.admin.listSessions(adminClinicId(req), id);
  }

  @Post('doctors/:id/sessions')
  createSession(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: CreateDoctorSessionInput,
  ) {
    return this.admin.createSession(adminClinicId(req), id, body);
  }

  @Patch('doctors/:id/sessions/:sessionId')
  updateSession(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
    @Body() body: UpdateDoctorSessionInput,
  ) {
    return this.admin.updateSession(adminClinicId(req), id, sessionId, body);
  }

  @Delete('doctors/:id/sessions/:sessionId')
  @HttpCode(204)
  deleteSession(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
  ) {
    return this.admin.deleteSession(adminClinicId(req), id, sessionId);
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
    return this.admin.createStaff(tenantHospitalId(req), clinicId, body);
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
