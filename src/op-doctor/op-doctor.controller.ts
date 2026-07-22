import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString, Matches } from 'class-validator';
import { AuthedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { SessionClaims } from '../auth/auth-token.service';
import { TenantScopeGuard } from '../common/tenant/tenant-scope';
import { TenantService } from '../common/tenant/tenant.service';
import { OpDoctorService } from './op-doctor.service';

class SaveNoteBody {
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() diagnosis?: string | null;
  @IsOptional() @IsString() prescriptions?: string | null;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'followUpDate must be YYYY-MM-DD' })
  followUpDate?: string | null;
}

/**
 * Doctor console reads/notes for the token engine (op mode). Notes are keyed by
 * encounterId over HTTP but stored against the encounter's linked bookingId, so
 * the existing note storage and history are reused (see OpDoctorService).
 */
@Controller('op')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
export class OpDoctorController {
  constructor(
    private readonly opDoctor: OpDoctorService,
    private readonly tenant: TenantService,
  ) {}

  /** GET /op/doctors/:id/completed — today's completed encounters (+ note flag). */
  @Get('doctors/:id/completed')
  @Roles('DOCTOR', 'STAFF', 'ADMIN')
  async completed(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.tenant.assertQueueAccess(req.user, id);
    return this.opDoctor.completed(id);
  }

  /** GET /op/encounters/:id/note — the doctor's note for an encounter (or null). */
  @Get('encounters/:id/note')
  @Roles('DOCTOR')
  getNote(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.opDoctor.getNote(doctorIdOf(req.user), id);
  }

  /** POST /op/encounters/:id/note — create/update the doctor's note. */
  @Post('encounters/:id/note')
  @Roles('DOCTOR')
  saveNote(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: SaveNoteBody,
  ) {
    return this.opDoctor.saveNote(doctorIdOf(req.user), id, body);
  }
}

function doctorIdOf(claims: SessionClaims | undefined): string {
  const id = claims?.doctorId ?? claims?.sub;
  if (!id) throw new ForbiddenException('missing doctor identity');
  return id;
}
