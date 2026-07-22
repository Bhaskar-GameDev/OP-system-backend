import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { BookingStatus } from '@prisma/client';
import { AuthedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { PrismaService } from '../common/prisma/prisma.service';
import { EtaService } from './eta.service';
import { QueueService } from './queue.service';
import { PatientStatusCompatService } from './patient-status-compat.service';
import { SessionKey } from './token.service';

type QueueStatusLabel = 'waiting' | 'next' | 'in_consultation' | 'done';

/** Patient-facing live status for one of their own bookings. */
export interface MyQueueStatus {
  bookingId: string;
  tokenNumber: string;
  servingToken: string | null; // front of the queue (currently being seen)
  patientsAhead: number;
  position: number; // 1-based
  total: number;
  etaMinutes: number;
  status: QueueStatusLabel;
}

/**
 * Patient-scoped queue status. Separate controller from the staff-only
 * QueueEngineController so the patient route carries its own PATIENT role guard.
 * REST companion to the Socket.io live feed: the app fetches this on load and
 * re-fetches it whenever the socket signals a change, so it can show the patient
 * their position AND the token currently being served. Reuses EtaService /
 * QueueService — no queue logic is duplicated here.
 */
@Controller('queue')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('PATIENT')
export class QueueStatusController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eta: EtaService,
    private readonly queue: QueueService,
    private readonly patientCompat: PatientStatusCompatService,
  ) {}

  /**
   * GET /queue/my-status?bookingId=... — live status for the patient's booking.
   * If bookingId is given it must belong to the caller; otherwise the patient's
   * most recent token-bearing active booking is used.
   */
  @Get('my-status')
  async myStatus(
    @Req() req: AuthedRequest,
    @Query('bookingId') bookingId?: string,
  ): Promise<MyQueueStatus> {
    const patientId = req.user?.sub;
    if (!patientId) throw new ForbiddenException('missing patient identity');

    const booking = await this.resolveBooking(patientId, bookingId);

    // Read cutover (reversible, per-clinic flag): serve from the new engine when
    // this patient's encounter is in the new queue, else fall through to legacy.
    const cutover = await this.patientCompat.tryStatus(booking);
    if (cutover) return cutover;

    const token = booking.tokenNumber;
    if (!token) {
      // no token issued yet (still pending payment) — nothing to track
      throw new NotFoundException('booking has no queue token');
    }

    const session: SessionKey = {
      doctorId: booking.doctorId,
      sessionDate: booking.sessionDate.toISOString().slice(0, 10),
      sessionType: booking.sessionType,
    };

    const [eta, servingToken] = await Promise.all([
      this.eta.etaFor(token, session),
      this.queue.frontToken(session),
    ]);

    // Not in the live queue any more (completed / no-show / cancelled, or the
    // session has been cleared): report a terminal "done" status.
    if (!eta) {
      return {
        bookingId: booking.id,
        tokenNumber: token,
        servingToken,
        patientsAhead: 0,
        position: 0,
        total: 0,
        etaMinutes: 0,
        status: 'done',
      };
    }

    return {
      bookingId: booking.id,
      tokenNumber: token,
      servingToken,
      patientsAhead: eta.patientsAhead,
      position: eta.position,
      total: eta.total,
      etaMinutes: eta.etaMinutes,
      status: labelFor(eta.patientsAhead),
    };
  }

  /** Find the target booking and assert it belongs to the caller. */
  private async resolveBooking(patientId: string, bookingId?: string) {
    const select = {
      id: true,
      patientId: true,
      doctorId: true,
      sessionDate: true,
      sessionType: true,
      tokenNumber: true,
      status: true,
    };

    if (bookingId) {
      const booking = await this.prisma.booking.findUnique({
        where: { id: bookingId },
        select,
      });
      if (!booking) throw new NotFoundException('booking not found');
      if (booking.patientId !== patientId) {
        throw new ForbiddenException('booking belongs to another patient');
      }
      return booking;
    }

    // fallback: the patient's most recent live (token-bearing) booking
    const booking = await this.prisma.booking.findFirst({
      where: {
        patientId,
        status: { in: [BookingStatus.BOOKED, BookingStatus.ACTIVE] },
        tokenNumber: { not: null },
      },
      orderBy: { sessionDate: 'desc' },
      select,
    });
    if (!booking) throw new NotFoundException('no active booking');
    return booking;
  }
}

function labelFor(patientsAhead: number): QueueStatusLabel {
  if (patientsAhead === 0) return 'in_consultation';
  if (patientsAhead === 1) return 'next';
  return 'waiting';
}
