import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ReceptionService } from './reception.service';
import { DAILY_SESSION_TYPE } from '../common/session/daily-session';
import { CheckInInput, RegisterWalkInInput } from './reception.dto';

/**
 * Reception desk endpoints. STAFF/ADMIN only, scoped to the caller's own clinic
 * via the JWT clinicId (never a request param) — same discipline as Admin Portal.
 */
@Controller('reception')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('STAFF', 'ADMIN')
export class ReceptionController {
  constructor(private readonly reception: ReceptionService) {}

  /** GET /reception/doctors — doctors in the caller's clinic (queue picker). */
  @Get('doctors')
  listDoctors(@Req() req: AuthedRequest) {
    return this.reception.listDoctors(clinicId(req));
  }

  /**
   * POST /reception/walkins — register a walk-in patient.
   * body: { mobile, name, doctorId, sessionDate: 'YYYY-MM-DD' }
   *
   * sessionType is no longer an input — a doctor sits one session per day, so
   * it is pinned. Anything the caller sends is ignored rather than rejected so
   * older reception clients keep working.
   */
  @Post('walkins')
  registerWalkIn(@Req() req: AuthedRequest, @Body() body: RegisterWalkInInput) {
    const mobile = body?.mobile?.trim();
    const name = body?.name?.trim();
    if (!mobile || !name) {
      throw new BadRequestException('mobile and name are required');
    }
    if (!body?.doctorId || !body?.sessionDate) {
      throw new BadRequestException('doctorId and sessionDate are required');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.sessionDate)) {
      throw new BadRequestException('sessionDate must be YYYY-MM-DD');
    }
    return this.reception.registerWalkIn(clinicId(req), {
      ...body,
      mobile,
      name,
      sessionType: DAILY_SESSION_TYPE,
    });
  }

  /**
   * GET /reception/bookings?doctorId&sessionDate — check-in roster for the day:
   * real bookings with patient name, status, and arrival flag. A sessionType
   * query param is accepted but ignored (one session per day).
   */
  @Get('bookings')
  listBookings(
    @Req() req: AuthedRequest,
    @Query('doctorId') doctorId: string,
    @Query('sessionDate') sessionDate: string,
  ) {
    if (!doctorId || !sessionDate) {
      throw new BadRequestException('doctorId and sessionDate are required');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) {
      throw new BadRequestException('sessionDate must be YYYY-MM-DD');
    }
    return this.reception.listBookings(clinicId(req), {
      doctorId,
      sessionDate,
      sessionType: DAILY_SESSION_TYPE,
    });
  }

  /** PATCH /reception/bookings/:id/checkin  body: { arrived: boolean } */
  @Patch('bookings/:id/checkin')
  checkin(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: CheckInInput,
  ) {
    if (typeof body?.arrived !== 'boolean') {
      throw new BadRequestException('arrived (boolean) is required');
    }
    return this.reception.setArrived(clinicId(req), id, body.arrived);
  }

  /**
   * POST /reception/bookings/:id/collect-payment — settle a pay-at-desk (voice)
   * booking's payment in cash/UPI at the desk. Flips the Payment to SUCCESS.
   */
  @Post('bookings/:id/collect-payment')
  collectPayment(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.reception.collectPayment(clinicId(req), id);
  }
}

function clinicId(req: AuthedRequest): string {
  const cid = req.user?.clinicId;
  if (!cid) throw new ForbiddenException('token missing clinic scope');
  return cid;
}
