import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { SessionType } from '@prisma/client';
import { AuthedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SessionClaims } from '../auth/auth-token.service';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { TokenSource } from './token.service';
import { QueueService } from './queue.service';
import { EtaService } from './eta.service';
import { ConsultationService } from './consultation.service';
import { AuditAction, AuditService } from './audit.service';
import { IssueTokenDto } from './dto/issue-token.dto';

/**
 * Queue Engine operations for staff/doctor clients: position/list/ETA reads and
 * queue control (done/no-show/skip/priority/reinsert). There is deliberately NO
 * raw token-issue OR raw enqueue route here, since a booking token must never
 * exist without either payment success (app bookings, Payments step hard rule)
 * or a real WALK_IN Booking row. Tokens enter the queue ONLY via an orchestrated
 * path that first creates the Booking: app bookings via payment-confirm, walk-ins
 * via POST /reception/walkins. Both reuse ConsultationService.enqueueBooking,
 * which also broadcasts the live update.
 */
@Controller('queue')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('DOCTOR', 'STAFF', 'ADMIN') // queue ops are staff/doctor-facing
export class QueueEngineController {
  constructor(
    private readonly queueService: QueueService,
    private readonly etaService: EtaService,
    private readonly consultationService: ConsultationService,
    private readonly audit: AuditService,
  ) {}

  @Get('position')
  async position(
    @Query('doctorId') doctorId: string,
    @Query('sessionDate') sessionDate: string,
    @Query('sessionType') sessionType: string,
    @Query('token') token: string,
  ) {
    const session = this.queryToSession(doctorId, sessionDate, sessionType);
    if (!token) throw new BadRequestException('token is required');
    const pos = await this.queueService.positionOf(token, session);
    if (!pos) throw new NotFoundException(`token ${token} not in queue`);
    return pos;
  }

  @Get('list')
  async list(
    @Query('doctorId') doctorId: string,
    @Query('sessionDate') sessionDate: string,
    @Query('sessionType') sessionType: string,
  ) {
    const session = this.queryToSession(doctorId, sessionDate, sessionType);
    return this.queueService.listWithScores(session);
  }

  // ── live ETA (computed, never stored) ────────────────────
  @Get('eta')
  async eta(
    @Query('doctorId') doctorId: string,
    @Query('sessionDate') sessionDate: string,
    @Query('sessionType') sessionType: string,
    @Query('token') token: string,
  ) {
    const session = this.queryToSession(doctorId, sessionDate, sessionType);
    if (!token) throw new BadRequestException('token is required');
    const eta = await this.etaService.etaFor(token, session);
    if (!eta) throw new NotFoundException(`token ${token} not in queue`);
    return eta;
  }

  @Get('eta-list')
  async etaList(
    @Query('doctorId') doctorId: string,
    @Query('sessionDate') sessionDate: string,
    @Query('sessionType') sessionType: string,
  ) {
    const session = this.queryToSession(doctorId, sessionDate, sessionType);
    return this.etaService.etaForQueue(session);
  }

  // ── DONE: advance the queue (rank-0 completes, next promoted) ──
  @Post('done')
  async done(
    @Req() req: AuthedRequest,
    @Body() body: IssueTokenDto & { expectedToken?: string },
  ) {
    this.validate(body);
    const result = await this.consultationService.markDone(body, body.expectedToken ?? '');
    await this.log(req, 'DONE', body, {
      token: body.expectedToken,
      metadata: { expectedToken: body.expectedToken },
    });
    return result;
  }

  // ── no-show: remove a specific token (not marked seen) ────
  @Post('no-show')
  async noShow(@Req() req: AuthedRequest, @Body() body: IssueTokenDto & { token?: string }) {
    this.validate(body);
    if (!body.token) throw new BadRequestException('token is required');
    const result = await this.consultationService.markNoShow(body, body.token);
    await this.log(req, 'NO_SHOW', body, { token: body.token });
    return result;
  }

  // ── skip: move a token to the back of the queue ──────────
  @Post('skip')
  async skip(@Req() req: AuthedRequest, @Body() body: IssueTokenDto & { token?: string }) {
    this.validate(body);
    if (!body.token) throw new BadRequestException('token is required');
    const result = await this.consultationService.skip(body, body.token);
    await this.log(req, 'SKIP', body, { token: body.token });
    return result;
  }

  // ── emergency priority: insert a new booking near the front ──
  @Post('priority')
  async priority(
    @Req() req: AuthedRequest,
    @Body() body: IssueTokenDto & { source?: string; bookingId?: string },
  ) {
    this.validate(body);
    if (!body.bookingId) throw new BadRequestException('bookingId is required');
    const source = this.parseSource(body.source);
    const result = await this.consultationService.priorityInsert(source, body, body.bookingId);
    await this.log(req, 'PRIORITY', body, {
      bookingId: body.bookingId,
      metadata: { source },
    });
    return result;
  }

  // ── reinsert: place a NO_SHOW patient after an anchor token ──
  @Post('reinsert')
  async reinsert(
    @Req() req: AuthedRequest,
    @Body()
    body: IssueTokenDto & {
      token?: string;
      afterToken?: string;
      bookingId?: string;
    },
  ) {
    this.validate(body);
    if (!body.token || !body.afterToken || !body.bookingId) {
      throw new BadRequestException(
        'token, afterToken and bookingId are required',
      );
    }
    const result = await this.consultationService.reinsert(
      body,
      body.token,
      body.afterToken,
      body.bookingId,
    );
    await this.log(req, 'REINSERT', body, {
      token: body.token,
      bookingId: body.bookingId,
      metadata: { afterToken: body.afterToken },
    });
    return result;
  }

  // ── helpers ──────────────────────────────────────────────
  /** Record the action against the authenticated actor (compliance trail). */
  private log(
    req: AuthedRequest,
    action: AuditAction,
    body: IssueTokenDto,
    target: { token?: string; bookingId?: string; metadata?: Record<string, unknown> },
  ): Promise<void> {
    const actor = req.user as SessionClaims; // guard guarantees this is set
    return this.audit.record(actor, {
      action,
      doctorId: body.doctorId,
      sessionDate: body.sessionDate,
      sessionType: body.sessionType as SessionType,
      token: target.token,
      bookingId: target.bookingId,
      metadata: target.metadata,
    });
  }

  private parseSource(raw?: string): TokenSource {
    switch (raw) {
      case 'APP':
      case undefined:
        return TokenSource.APP;
      case 'WALK_IN':
        return TokenSource.WALK_IN;
      case 'VOICE':
        return TokenSource.VOICE;
      default:
        throw new BadRequestException('source must be APP, WALK_IN or VOICE');
    }
  }

  private queryToSession(
    doctorId: string,
    sessionDate: string,
    sessionType: string,
  ): IssueTokenDto {
    const body = { doctorId, sessionDate, sessionType } as IssueTokenDto;
    this.validate(body);
    return body;
  }

  private validate(body: IssueTokenDto): void {
    if (!body?.doctorId || !body?.sessionDate || !body?.sessionType) {
      throw new BadRequestException(
        'doctorId, sessionDate, sessionType are required',
      );
    }
    if (body.sessionType !== 'MORNING' && body.sessionType !== 'EVENING') {
      throw new BadRequestException('sessionType must be MORNING or EVENING');
    }
  }
}
