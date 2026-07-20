import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ProfileService } from './profile.service';
import { UpdateProfileInput } from './profile.dto';

/**
 * Patient self-service profile. PATIENT role only; always scoped to the caller's
 * own record via the JWT (sub = patientId) — never a request param.
 */
@Controller('me')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('PATIENT')
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  /** GET /me — the signed-in patient's profile. */
  @Get()
  get(@Req() req: AuthedRequest) {
    return this.profile.getProfile(patientId(req));
  }

  /** PATCH /me — update name (required) and optional age / gender. */
  @Patch()
  update(@Req() req: AuthedRequest, @Body() body: UpdateProfileInput) {
    return this.profile.updateProfile(patientId(req), body ?? {});
  }
}

function patientId(req: AuthedRequest): string {
  const id = req.user?.sub;
  if (!id) throw new ForbiddenException('missing patient identity');
  return id;
}
