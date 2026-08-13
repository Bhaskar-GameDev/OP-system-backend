import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  BookingSource,
  BookingStatus,
  EncounterStatus,
  PaymentStatus,
  Prisma,
  RegistrationSource,
} from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { SessionResolverService } from '../bookings/session-resolver.service';
import { QueueService } from '../queue-engine/queue.service';
import { AuditService } from '../queue-engine/audit.service';
import { PaymentsService } from '../payments/payments.service';
import { OpMirrorService } from '../op-mirror/op-mirror.service';
import { ConsultationEngineService } from '../consultation/consultation-engine.service';
import { QueueReadService } from '../read-side/queue-read.service';
import { OpConfigService } from '../config-engine/op-config.service';
import { SessionKey } from '../queue-engine/token.service';
import { SessionClaims } from '../auth/auth-token.service';
import { SMS_SENDER, SmsSender } from '../auth/sms.sender';
import {
  VoiceAppointmentRecord,
  VoiceAvailabilityRequest,
  VoiceAvailabilityResponse,
  VoiceBookingRequest,
  VoiceBookingResult,
  VoiceCallLogRequest,
  VoiceDoctorAvailability,
  VoiceLookupRequest,
  VoiceQueueStatusRecord,
  VoiceQueueStatusRequest,
} from './voice.dto';
import { todayYmdLocal, ymd } from '../common/dates';

// Statuses a caller can still act on over the phone (token issued, in play).
const LIVE_STATUSES: BookingStatus[] = [BookingStatus.BOOKED, BookingStatus.ACTIVE];

/**
 * Voice (phone) booking API. The voice agent holds no DB — every state change
 * goes through here, reusing the SAME atomic token/queue engine the app and
 * reception desk use, so a phone booking is indistinguishable downstream.
 *
 * Tenant routing is by the inbound DID: `VoiceNumber` maps the dialed number to a
 * clinic (and thus a hospital), so a call lands in the right tenant with no
 * staff identity involved. Payment is the pay-at-desk hybrid: a real token is
 * issued now (so the agent can quote position + ETA) with an unpaid Payment;
 * reception settles it on arrival.
 */
@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);

  constructor(
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    private readonly prisma: PrismaService,
    private readonly resolver: SessionResolverService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    private readonly payments: PaymentsService,
    private readonly mirror: OpMirrorService,
    private readonly consultEngine: ConsultationEngineService,
    private readonly queueRead: QueueReadService,
    private readonly config: OpConfigService,
  ) {}

  /** DID -> owning clinic. Unknown number is a 404 the agent surfaces as "sorry,
   *  this number isn't set up". */
  private async clinicForDid(
    didNumber: string,
  ): Promise<{ id: string; name: string; contactNumber: string | null }> {
    const mapping = await this.prisma.voiceNumber.findUnique({
      where: { didNumber },
      select: { clinic: { select: { id: true, name: true, contactNumber: true } } },
    });
    if (!mapping) throw new NotFoundException('no clinic is configured for this number');
    return mapping.clinic;
  }

  // ── availability ──────────────────────────────────────────────────────────
  async availability(req: VoiceAvailabilityRequest): Promise<VoiceAvailabilityResponse> {
    const clinic = await this.clinicForDid(req.didNumber);

    const specialty = req.specialty?.trim().toLowerCase();
    const doctors = await this.prisma.doctor.findMany({
      where: { clinicId: clinic.id },
      select: {
        id: true,
        name: true,
        specialization: true,
        consultationFee: true,
        avgConsultMinutes: true,
      },
      orderBy: { name: 'asc' },
    });

    const out: VoiceDoctorAvailability[] = [];
    let sessionDate = todayYmdLocal();

    for (const d of doctors) {
      if (specialty && !(d.specialization ?? '').toLowerCase().includes(specialty)) continue;

      // Per-doctor isolation: this loop touches the session resolver, Redis and
      // the config engine once per doctor. One doctor with a broken schedule (or
      // a Redis blip on their queue key) must not blank the whole clinic's
      // availability — the caller would be told "nothing today" when four other
      // doctors are open. Skip the bad one, serve the rest.
      try {
        const today = await this.resolver.resolveToday(d.id);
        if (today.status !== 'OPEN') continue;
        const s = today.session;
        if (req.sessionType && s.sessionType !== req.sessionType) continue;

        sessionDate = s.sessionDate;
        const session: SessionKey = {
          doctorId: d.id,
          sessionDate: s.sessionDate,
          sessionType: s.sessionType,
        };
        // A new joiner lands at the back: their wait = current queue size × avg.
        // Read cutover (reversible, per-clinic): when flipped, count the NEW engine's
        // live queue for this doctor instead of the legacy queue. Aggregate only, so
        // no per-caller token divergence — the agent just quotes an accurate wait.
        let waiting = await this.queue.size(session);
        if (
          await this.config.get(
            'reads.cutover.voiceAvailability',
            { clinicId: clinic.id },
            false,
          )
        ) {
          waiting = await this.prisma.queueReadModel.count({
            where: { doctorId: d.id, status: EncounterStatus.WAITING },
          });
        }
        out.push({
          doctorId: d.id,
          doctorName: d.name,
          specialization: d.specialization,
          consultationFee: d.consultationFee,
          sessions: [
            { sessionType: s.sessionType, waiting, etaMinutes: waiting * d.avgConsultMinutes },
          ],
        });
      } catch (err) {
        this.logger.warn(
          `availability skipped doctor ${d.id} at clinic ${clinic.id}: ${(err as Error).message}`,
        );
      }
    }

    return {
      clinicId: clinic.id,
      clinicName: clinic.name,
      clinicContactNumber: clinic.contactNumber,
      sessionDate,
      doctors: out,
    };
  }

  // ── book ──────────────────────────────────────────────────────────────────
  async book(req: VoiceBookingRequest): Promise<VoiceBookingResult> {
    const clinic = await this.clinicForDid(req.didNumber);

    // Idempotent on callSid: a retried call returns the existing booking.
    const existing = await this.prisma.booking.findUnique({
      where: { voiceCallSid: req.callSid },
      select: {
        id: true, tokenNumber: true, doctorId: true, sessionDate: true,
        sessionType: true, status: true, doctor: { select: { name: true } },
      },
    });
    if (existing) {
      return {
        bookingId: existing.id,
        tokenNumber: existing.tokenNumber ?? '',
        doctorId: existing.doctorId,
        doctorName: existing.doctor.name,
        sessionDate: ymd(existing.sessionDate),
        sessionType: existing.sessionType,
        status: existing.status,
      };
    }

    const doctor = await this.prisma.doctor.findUnique({
      where: { id: req.doctorId },
      select: { clinicId: true, name: true, consultationFee: true, avgConsultMinutes: true },
    });
    if (!doctor) throw new NotFoundException('doctor not found');
    if (doctor.clinicId !== clinic.id) {
      throw new ForbiddenException('doctor belongs to another clinic');
    }

    // Same-day model: book into the doctor's currently-joinable session.
    const today = await this.resolver.resolveToday(req.doctorId);
    if (today.status !== 'OPEN') {
      throw new ConflictException('no session is open for this doctor today');
    }
    const resolved = today.session;

    // Don't silently book a different session than the caller picked: if they
    // asked for one that isn't the open one now, reject so the agent re-offers.
    if (req.sessionType && req.sessionType !== resolved.sessionType) {
      throw new ConflictException('the requested session is not the one open now');
    }

    const patient = await this.prisma.patient.upsert({
      where: { mobile: req.patientPhone },
      create: { mobile: req.patientPhone, name: req.patientName ?? '' },
      update: req.patientName ? { name: req.patientName } : {},
      select: { id: true },
    });

    // Abuse guard: one live token per caller per doctor-session. A repeat call
    // (different callSid) for a doctor they already hold a token with returns the
    // existing booking rather than minting a second phantom hold.
    const heldDate = new Date(resolved.sessionDate);
    const existingHold = await this.prisma.booking.findFirst({
      where: {
        patientId: patient.id,
        doctorId: req.doctorId,
        sessionDate: heldDate,
        sessionType: resolved.sessionType,
        status: { in: [BookingStatus.BOOKED, BookingStatus.ACTIVE] },
      },
      select: { id: true, tokenNumber: true, status: true },
    });
    if (existingHold) {
      return {
        bookingId: existingHold.id,
        tokenNumber: existingHold.tokenNumber ?? '',
        doctorId: req.doctorId,
        doctorName: doctor.name,
        sessionDate: resolved.sessionDate,
        sessionType: resolved.sessionType,
        status: existingHold.status,
      };
    }

    // Real BOOKED voice booking, flagged pay-at-desk, with the callSid idempotency key.
    const booking = await this.prisma.booking.create({
      data: {
        patientId: patient.id,
        doctorId: req.doctorId,
        source: BookingSource.VOICE,
        sessionDate: new Date(resolved.sessionDate),
        sessionType: resolved.sessionType,
        status: BookingStatus.BOOKED,
        payAtDesk: true,
        voiceCallSid: req.callSid,
      },
      select: { id: true },
    });

    // OP cutover: the token-based OP engine is now the source of truth for the
    // token, so raise it there (register -> check-in -> issue token -> enqueue)
    // instead of the legacy queue engine. `present: true` runs the same
    // primitives the reception combined desk uses, and returns the issued OP
    // token — the number the caller is told AND the number the OP read models
    // (doctor / reception frontends) render. Idempotent on callSid.
    const op = await this.mirror.mirror({
      source: RegistrationSource.VOICE_AGENT,
      doctorId: req.doctorId,
      patientId: patient.id,
      mobile: req.patientPhone,
      name: req.patientName ?? undefined,
      serviceDate: resolved.sessionDate,
      idempotencyKey: req.callSid,
      legacyBookingId: booking.id,
      present: true,
    });
    if (!op?.token) {
      // OP is authoritative now: with no token there is nothing to quote and
      // nothing shows in the queue. Surface it so the agent re-offers rather than
      // confirming a phantom, token-less booking.
      throw new ConflictException('could not raise a token for this session');
    }
    const tokenNumber = op.token.displayNumber;

    // Everything below this line is bookkeeping on the LEGACY row — the OP token
    // above is already issued and enqueued, and it is what the doctor and
    // reception screens render. So a failure here must NOT fail the caller:
    // throwing would tell them "sorry, couldn't book" while they silently hold a
    // real place in a real queue, which is the worst possible outcome. Log it
    // loudly for desk reconciliation and confirm the token they actually have.
    let bookingStatus: BookingStatus = BookingStatus.BOOKED;
    try {
      // Unpaid Payment (status CREATED) = amount due at the desk; link it on.
      const payment = await this.prisma.payment.create({
        data: {
          bookingId: booking.id,
          amount: doctor.consultationFee * 100, // paise, matching the paid path
          status: PaymentStatus.CREATED,
        },
        select: { id: true },
      });
      // Mirror the OP token onto the legacy Booking so lookup/cancel still read a
      // single, consistent number (the legacy row is kept only as the correlation
      // record + refund/audit anchor; it no longer mints its own token).
      const updated = await this.prisma.booking.update({
        where: { id: booking.id },
        data: { tokenNumber, paymentId: payment.id },
        select: { status: true },
      });
      bookingStatus = updated.status;
    } catch (err) {
      this.logger.error(
        `token ${tokenNumber} issued but legacy booking ${booking.id} bookkeeping failed ` +
          `(patient ${req.patientPhone}, doctor ${req.doctorId}) — collect the fee at the desk: ` +
          `${(err as Error).message}`,
      );
    }

    // The caller has no app, so this SMS is their ONLY durable record of the
    // token — they otherwise have a number a synthetic voice said once, possibly
    // in their second language. Best-effort by design: the token is already
    // issued and enqueued, so a provider outage must not undo a real booking.
    await this.sendBookingSms({
      mobile: req.patientPhone,
      tokenNumber,
      doctorName: doctor.name,
      clinicName: clinic.name,
      encounterId: op.encounterId,
      avgConsultMinutes: doctor.avgConsultMinutes,
    });

    return {
      bookingId: booking.id,
      tokenNumber,
      doctorId: req.doctorId,
      doctorName: doctor.name,
      sessionDate: resolved.sessionDate,
      sessionType: resolved.sessionType,
      status: bookingStatus,
    };
  }

  // ── lookup ────────────────────────────────────────────────────────────────
  async lookup(req: VoiceLookupRequest): Promise<VoiceAppointmentRecord[]> {
    const clinic = await this.clinicForDid(req.didNumber);
    const patient = await this.prisma.patient.findUnique({
      where: { mobile: req.patientPhone },
      select: { id: true },
    });
    if (!patient) return [];

    // Scope to the clinic the caller dialed — they only manage appointments there.
    const rows = await this.prisma.booking.findMany({
      where: {
        patientId: patient.id,
        status: { in: LIVE_STATUSES },
        doctor: { clinicId: clinic.id },
      },
      select: {
        id: true, tokenNumber: true, sessionDate: true, sessionType: true, status: true,
        doctorId: true, doctor: { select: { name: true, specialization: true } },
      },
      orderBy: { sessionDate: 'asc' },
    });
    return rows.map((b) => ({
      appointmentId: b.id,
      doctorId: b.doctorId,
      doctorName: b.doctor.name,
      specialization: b.doctor.specialization,
      sessionDate: ymd(b.sessionDate),
      sessionType: b.sessionType,
      tokenNumber: b.tokenNumber,
      status: b.status,
    }));
  }

  /**
   * Confirmation SMS for a phone booking.
   *
   * Deliberately NOT NotificationsService.bookingConfirmed(): that sends a PUSH
   * to a stored FCM token, and a voice caller is by definition someone without
   * the app — they would receive nothing. The body is also self-contained for
   * the same reason: no deep link, no "open the app", just the facts they need
   * to walk into the clinic.
   */
  private async sendBookingSms(args: {
    mobile: string;
    tokenNumber: string;
    doctorName: string;
    clinicName: string;
    encounterId: string;
    avgConsultMinutes: number;
  }): Promise<void> {
    try {
      // Position comes from the OP read model now (same source the frontends and
      // queue-status read). It is a projection, so it can briefly lag the enqueue
      // — if so we simply omit the wait sentence rather than quote a wrong one.
      const tracking = await this.queueRead.patientTracking(args.encounterId);
      let wait = '';
      if (tracking) {
        wait =
          tracking.ahead === 0
            ? ' You are next.'
            : ` ${tracking.ahead} ahead of you, about ${tracking.ahead * args.avgConsultMinutes} minutes.`;
      }

      await this.sms.sendText(
        args.mobile,
        `Your token is ${args.tokenNumber} for ${args.doctorName} at ${args.clinicName}.${wait} Please pay at the reception desk on arrival.`,
      );
    } catch (err) {
      this.logger.error(
        `booking SMS failed for ${args.tokenNumber}: ${(err as Error).message}`,
      );
    }
  }

  // ── queue status ──────────────────────────────────────────────────────────
  /**
   * Live queue position for every token the caller currently holds at the dialed
   * clinic — "what's my number, how many ahead, how long".
   *
   * Returns an EMPTY ARRAY when the caller has no live booking. Deliberately not
   * a 404: the agent has to tell "you have no booking" apart from "the backend
   * failed", and those need different things said to the caller.
   */
  async queueStatus(req: VoiceQueueStatusRequest): Promise<VoiceQueueStatusRecord[]> {
    const clinic = await this.clinicForDid(req.didNumber);
    const patient = await this.prisma.patient.findUnique({
      where: { mobile: req.patientPhone },
      select: { id: true },
    });
    if (!patient) return [];

    const bookings = await this.prisma.booking.findMany({
      where: {
        patientId: patient.id,
        status: { in: LIVE_STATUSES },
        tokenNumber: { not: null },
        // Clinic scope: a token held at another clinic is not this caller's
        // business on this line, even though it is the same patient record.
        doctor: { clinicId: clinic.id },
      },
      select: {
        id: true,
        tokenNumber: true,
        doctorId: true,
        sessionDate: true,
        sessionType: true,
        doctor: { select: { name: true, specialization: true, avgConsultMinutes: true } },
      },
      orderBy: { sessionDate: 'asc' },
    });

    const out: VoiceQueueStatusRecord[] = [];
    for (const b of bookings) {
      // OP cutover: position/ETA come from the OP read model now, not the legacy
      // queue. A voice booking's legacy row links to its OP encounter via the
      // backfill column OR the mirror channelMeta; read that encounter's live
      // tracking.
      const encounterId = await this.resolveEncounterId(b.id);
      if (!encounterId) continue;
      const tracking = await this.queueRead.patientTracking(encounterId);
      // No tracking / no order key means the token has left the live queue
      // (called / completed / no-show) — skip it rather than read a stale spot.
      if (!tracking || tracking.tokenNumber == null) continue;

      out.push({
        bookingId: b.id,
        tokenNumber: tracking.tokenNumber,
        doctorName: b.doctor.name,
        specialization: b.doctor.specialization,
        sessionType: b.sessionType,
        patientsAhead: tracking.ahead,
        estimatedWaitMinutes: tracking.ahead * b.doctor.avgConsultMinutes,
        currentlyServing: tracking.nowServingToken,
      });
    }
    return out;
  }

  /**
   * legacy bookingId -> OP encounterId. A backfilled booking carries the link on
   * Encounter.legacyBookingId; a mirror-created one (voice/app) carries it in
   * Registration.channelMeta.legacyBookingId. Check both — a freshly voice-booked
   * caller only has the channelMeta link, so resolving by column alone misses them.
   */
  private async resolveEncounterId(bookingId: string): Promise<string | null> {
    const byColumn = await this.prisma.encounter.findUnique({
      where: { legacyBookingId: bookingId },
      select: { id: true },
    });
    if (byColumn) return byColumn.id;
    const reg = await this.prisma.registration.findFirst({
      where: { channelMeta: { path: ['legacyBookingId'], equals: bookingId } },
      select: { encounterId: true },
    });
    return reg?.encounterId ?? null;
  }

  // ── cancel ────────────────────────────────────────────────────────────────
  async cancel(appointmentId: string): Promise<VoiceAppointmentRecord> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: appointmentId },
      select: {
        id: true, doctorId: true, tokenNumber: true, sessionDate: true, sessionType: true,
        doctor: { select: { name: true, specialization: true, clinicId: true } },
        patientId: true,
      },
    });
    if (!booking) throw new NotFoundException('appointment not found');

    // Race-safe status flip + queue removal + refund-if-paid (pay-at-desk has no
    // captured payment, so this just cancels). Status gate is inside cancelBooking.
    await this.payments.cancelBooking(appointmentId, { reason: 'cancelled by phone' });

    // OP cutover: the token the caller holds lives in the OP engine (raised at
    // booking), so cancel the linked OP encounter too — pull it from the line so
    // it disappears from the doctor/reception frontends and queue-status. Best
    // effort: the legacy cancel above already succeeded, and the encounter may be
    // in a state CANCEL is illegal from (already called / cancelled) — never fail
    // the caller's cancel over it.
    const encounterId = await this.resolveEncounterId(booking.id);
    if (encounterId) {
      try {
        await this.consultEngine.cancel(encounterId, { actorId: booking.patientId });
      } catch (err) {
        this.logger.warn(
          `OP encounter cancel skipped for booking ${booking.id}: ${(err as Error).message}`,
        );
      }
    }

    // Compliance trail, attributed to the voice channel.
    const actor: SessionClaims = {
      sub: booking.patientId,
      role: 'PATIENT',
      clinicId: booking.doctor.clinicId,
    };
    await this.audit.record(actor, {
      action: 'CANCEL',
      doctorId: booking.doctorId,
      sessionDate: ymd(booking.sessionDate),
      sessionType: booking.sessionType,
      token: booking.tokenNumber ?? undefined,
      bookingId: booking.id,
      metadata: { channel: 'VOICE' },
    });

    return {
      appointmentId: booking.id,
      doctorId: booking.doctorId,
      doctorName: booking.doctor.name,
      specialization: booking.doctor.specialization,
      sessionDate: ymd(booking.sessionDate),
      sessionType: booking.sessionType,
      tokenNumber: booking.tokenNumber,
      status: BookingStatus.CANCELLED,
    };
  }

  // ── call log ──────────────────────────────────────────────────────────────
  /**
   * Telemetry write at the end of a call — transcript, slots, outcome.
   *
   * NEVER throws. It runs during the agent's teardown, after the caller has
   * already been told their token, so failing it can only produce noise: the
   * agent's own catch would log a second error and nothing about the booking
   * changes. `ok: false` says the line was lost without pretending it was
   * written.
   */
  async saveCallLog(req: VoiceCallLogRequest): Promise<{ ok: boolean }> {
    try {
      return await this.writeCallLog(req);
    } catch (err) {
      this.logger.error(
        `call log write failed for ${req.callSid}: ${(err as Error).message}`,
      );
      return { ok: false };
    }
  }

  private async writeCallLog(req: VoiceCallLogRequest): Promise<{ ok: true }> {
    const clinicId = req.didNumber
      ? (await this.prisma.voiceNumber.findUnique({
          where: { didNumber: req.didNumber },
          select: { clinicId: true },
        }))?.clinicId ?? null
      : null;

    const data = {
      didNumber: req.didNumber ?? null,
      callerPhone: req.callerPhone ?? null,
      clinicId,
      language: req.language ?? null,
      transcript: (req.transcript ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      slots: (req.slots ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      bookingId: req.bookingId ?? null,
      outcome: req.outcome ?? null,
      durationSeconds: req.duration ?? null,
    };
    await this.prisma.voiceCallLog.upsert({
      where: { callSid: req.callSid },
      create: { callSid: req.callSid, ...data },
      update: data,
    });
    return { ok: true };
  }
}

