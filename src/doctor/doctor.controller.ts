import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionType } from '@prisma/client';
import { AuthedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { DoctorService } from './doctor.service';
import { ConsultationNotesService } from '../consultation-notes/consultation-notes.service';
import { SaveConsultationNoteInput } from '../consultation-notes/consultation-note.dto';

/**
 * Doctor Dashboard read endpoints. DOCTOR role only; every response is scoped to
 * the authenticated doctor via the JWT's doctorId — never a request param — so a
 * doctor can only ever see their own session. Queue mutations (done/skip/no-show)
 * are NOT here: they reuse the existing audited Queue Engine routes (/queue/*).
 */
@Controller('doctor')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('DOCTOR')
export class DoctorController {
  constructor(
    private readonly doctor: DoctorService,
    private readonly notes: ConsultationNotesService,
  ) {}

  /** GET /doctor/me — the signed-in doctor's profile + session metadata. */
  @Get('me')
  me(@Req() req: AuthedRequest) {
    return this.doctor.getProfile(doctorId(req));
  }

  /**
   * GET /doctor/queue?sessionType=MORNING|EVENING — today's live queue for the
   * signed-in doctor, front -> back, enriched with patient name / type / status.
   */
  @Get('queue')
  queue(@Req() req: AuthedRequest, @Query('sessionType') sessionType: string) {
    if (sessionType !== 'MORNING' && sessionType !== 'EVENING') {
      throw new BadRequestException('sessionType must be MORNING or EVENING');
    }
    return this.doctor.getQueue(doctorId(req), sessionType as SessionType);
  }

  /**
   * GET /doctor/completed?sessionType=MORNING|EVENING — today's completed
   * consultations (they've left the live queue) for note view/edit.
   */
  @Get('completed')
  completed(@Req() req: AuthedRequest, @Query('sessionType') sessionType: string) {
    if (sessionType !== 'MORNING' && sessionType !== 'EVENING') {
      throw new BadRequestException('sessionType must be MORNING or EVENING');
    }
    return this.doctor.getCompleted(doctorId(req), sessionType as SessionType);
  }

  // ─── Consultation notes (doctor-scoped to their own bookings) ───

  /** POST /doctor/notes — create or update the note for one of my bookings. */
  @Post('notes')
  saveNote(@Req() req: AuthedRequest, @Body() body: SaveConsultationNoteInput) {
    return this.notes.saveForDoctor(doctorId(req), body);
  }

  /** GET /doctor/notes/:bookingId — my note for a booking, or null. */
  @Get('notes/:bookingId')
  getNote(@Req() req: AuthedRequest, @Param('bookingId') bookingId: string) {
    return this.notes.getForDoctor(doctorId(req), bookingId);
  }
}

/** The doctor's own id from the token (doctorId claim, sub as fallback). */
function doctorId(req: AuthedRequest): string {
  const id = req.user?.doctorId ?? req.user?.sub;
  if (!id) throw new ForbiddenException('token missing doctor scope');
  return id;
}
