import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { SessionClaims } from '../auth/auth-token.service';
import { BookingActionsService } from './booking-actions.service';

/**
 * Patient-initiated cancellation. PATIENT-only; the patient id comes from the
 * JWT `sub`, and the service enforces that the booking is the caller's own (404
 * otherwise).
 *
 * Reschedule was removed when booking became same-day-only: there is no future
 * date to move to, and a morning->evening hop is equivalent to cancel + rejoin.
 * The old POST /bookings/:id/reschedule route now 404s.
 */
@Controller('bookings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('PATIENT')
export class BookingActionsController {
  constructor(private readonly actions: BookingActionsService) {}

  @Post(':id/cancel')
  cancel(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    return this.actions.cancel(claims(req), id, body?.reason);
  }
}

function claims(req: AuthedRequest): SessionClaims {
  const c = req.user;
  if (!c?.sub) throw new BadRequestException('missing patient identity');
  return c;
}
