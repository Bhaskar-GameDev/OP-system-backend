import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BookingSource,
  BookingStatus,
  CheckInMethod,
  OpPaymentMode,
  PaymentStatus,
  RegistrationSource,
  SessionType,
} from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ConsultationService } from '../queue-engine/consultation.service';
import { OpMirrorService } from '../op-mirror/op-mirror.service';
import { LegacyRosterCompatService } from './legacy-roster-compat.service';
import { CheckInService } from '../check-in/checkin.service';
import { OpPaymentService } from '../op-payments/op-payment.service';
import { OpQueueService } from '../queue/op-queue.service';
import { SessionKey, TokenSource } from '../queue-engine/token.service';
import {
  BookingRosterView,
  CheckInView,
  CollectPaymentInput,
  CollectPaymentView,
  DeskPaymentMode,
  ReceptionDoctorView,
  RegisterWalkInInput,
  WalkInView,
  toBookingRosterView,
  toCheckInView,
  toReceptionDoctorView,
} from './reception.dto';

/**
 * Reception desk — patient physical check-in (Arrived/Not Arrived).
 *
 * This is PURELY informational: it sets/clears bookings.checked_in_at and never
 * touches the Redis queue or any queue mutation. Check-in is a separate concept
 * from queue position and from the no-show queue action — a patient can be
 * checked in and still be marked no-show later (different flows).
 *
 * Scope is the caller's clinicId from their JWT (STAFF/ADMIN), exactly like the
 * Admin Portal: the booking's owning clinic (via doctor.clinicId) must match, or
 * it's 403 — staff from another clinic cannot check in a booking that isn't
 * theirs even with a real booking id.
 */
@Injectable()
export class ReceptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consult: ConsultationService,
    private readonly mirror: OpMirrorService,
    private readonly rosterCompat: LegacyRosterCompatService,
    private readonly checkInEngine: CheckInService,
    private readonly opPayments: OpPaymentService,
    private readonly opQueue: OpQueueService,
  ) {}

  /**
   * Register a walk-in: ensure the patient (by mobile), create a REAL WALK_IN
   * Booking (status BOOKED, no payment), then issue the token + enqueue via the
   * same atomic primitive the paid path uses. The booking's tokenNumber is
   * written back exactly like payment-confirm. If it lands at rank 0 it is
   * promoted to ACTIVE by enqueueBooking.
   *
   * The resulting booking carries a real bookingId, so it is indistinguishable
   * from an app booking for check-in / no-show / skip / priority / reinsert.
   */
  async registerWalkIn(
    clinicId: string,
    input: RegisterWalkInInput,
  ): Promise<WalkInView> {
    // clinic scope: the doctor must belong to the caller's clinic
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: input.doctorId },
      select: { clinicId: true, consultationFee: true },
    });
    if (!doctor) throw new NotFoundException('doctor not found');
    if (doctor.clinicId !== clinicId) {
      throw new ForbiddenException('doctor belongs to another clinic');
    }

    // ensure patient by mobile; fill a blank name if we learn one
    const patient = await this.prisma.patient.upsert({
      where: { mobile: input.mobile },
      create: { mobile: input.mobile, name: input.name },
      update: {},
    });
    let patientName = patient.name;
    if (!patient.name && input.name) {
      await this.prisma.patient.update({
        where: { id: patient.id },
        data: { name: input.name },
      });
      patientName = input.name;
    }
    // An existing record keeps its stored name — a desk typo must never rename a
    // real patient. But the mismatch cannot stay silent either: the doctor's
    // screen will show `patientName`, so the desk is told which record it hit.
    const nameMismatch = Boolean(
      input.name && patientName && patientName.trim() !== input.name.trim(),
    );

    // real booking row — BOOKED so the promote guard (BOOKED -> ACTIVE) holds.
    // payAtDesk + an unpaid Payment, exactly like a voice booking: the desk owes
    // this visit's fee, so the money is a tracked row from the first second
    // rather than cash that only exists in someone's memory. It NEVER gates the
    // token — the walk-in is standing right there and gets their number now.
    const booking = await this.prisma.booking.create({
      data: {
        patientId: patient.id,
        doctorId: input.doctorId,
        source: BookingSource.WALK_IN,
        sessionDate: new Date(input.sessionDate),
        sessionType: input.sessionType as SessionType,
        status: BookingStatus.BOOKED,
        payAtDesk: true,
      },
      select: { id: true },
    });
    const walkInPayment = await this.prisma.payment.create({
      data: {
        bookingId: booking.id,
        amount: doctor.consultationFee * 100, // paise, matching the voice path
        status: PaymentStatus.CREATED,
      },
      select: { id: true },
    });
    await this.prisma.booking.update({
      where: { id: booking.id },
      data: { paymentId: walkInPayment.id },
    });

    const session: SessionKey = {
      doctorId: input.doctorId,
      sessionDate: input.sessionDate,
      sessionType: input.sessionType,
    };

    // Dual-write to the new engine FIRST. The walk-in patient is at the desk, so
    // this is the combined path: register + check-in + token + enqueue. It runs
    // ahead of the legacy enqueue purely so the OP token can become the ONE
    // number for this visit — nothing has been quoted to the patient yet, so OP
    // is free to mint. Still best effort: it never blocks or fails the booking.
    const op = await this.mirror.mirror({
      source: RegistrationSource.RECEPTION,
      doctorId: input.doctorId,
      patientId: patient.id,
      mobile: input.mobile,
      name: input.name,
      serviceDate: input.sessionDate,
      idempotencyKey: booking.id,
      legacyBookingId: booking.id,
      actorId: clinicId,
      present: true,
    });

    // atomic token issue + enqueue (+ promote if front) + live broadcast.
    // Carries the OP number when there is one, so the doctor screen (legacy
    // Redis queue) and the reception roster (OP read model) cannot disagree
    // whichever way the cutover flags are set. When the mirror failed we fall
    // back to legacy minting — a desk must never be left without a token.
    const entry = await this.consult.enqueueBooking(
      TokenSource.WALK_IN,
      session,
      booking.id,
      op?.token?.displayNumber ?? '',
    );

    // write the display token back, exactly like payment-confirm
    const updated = await this.prisma.booking.update({
      where: { id: booking.id },
      data: { tokenNumber: entry.tokenNumber },
      select: { id: true, patientId: true, tokenNumber: true, status: true },
    });

    return {
      bookingId: updated.id,
      patientId: updated.patientId,
      patientName,
      nameMismatch,
      tokenNumber: updated.tokenNumber ?? entry.tokenNumber,
      status: updated.status,
      doctorId: input.doctorId,
      sessionDate: input.sessionDate,
      sessionType: input.sessionType,
    };
  }

  /**
   * Check-in roster for a session: every real booking (token issued) for the
   * doctor/date/session, with patient name, status, and arrival flag — the list
   * the desk toggles Arrived against. Clinic-scoped: the doctor must belong to
   * the caller's clinic (403 otherwise), same as walk-in registration.
   *
   * PENDING_PAYMENT bookings are excluded — they have no token and aren't real
   * patients at the desk yet. Ordered by token so it reads like the queue.
   */
  async listBookings(
    clinicId: string,
    session: SessionKey,
  ): Promise<BookingRosterView[]> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: session.doctorId },
      select: { clinicId: true },
    });
    if (!doctor) throw new NotFoundException('doctor not found');
    if (doctor.clinicId !== clinicId) {
      throw new ForbiddenException('doctor belongs to another clinic');
    }

    // Read cutover (Task 5, reversible): when this clinic is flipped, serve the
    // roster from the new engine in the SAME wire shape. Default off -> legacy.
    if (await this.rosterCompat.enabled(clinicId)) {
      return this.rosterCompat.roster(session);
    }

    const rows = await this.prisma.booking.findMany({
      where: {
        doctorId: session.doctorId,
        sessionDate: new Date(session.sessionDate),
        sessionType: session.sessionType as SessionType,
        status: { not: BookingStatus.PENDING_PAYMENT },
      },
      select: {
        id: true,
        tokenNumber: true,
        source: true,
        status: true,
        checkedInAt: true,
        payAtDesk: true,
        payment: { select: { status: true, amount: true, deskMode: true } },
        patient: { select: { name: true } },
      },
      orderBy: { tokenNumber: 'asc' },
    });
    return rows.map(toBookingRosterView);
  }

  /**
   * Collect a pay-at-desk payment at the counter — for a voice booking OR a
   * walk-in, which now carries the same unpaid Payment. Records HOW it was taken
   * (cash / UPI / corporate bill / waiver), how MUCH was actually taken, and WHO
   * took it.
   *
   * Two rows are written, deliberately:
   *   - the decoupled OpPayment (mode + amount + a PaymentSettled event carrying
   *     actorId) — the audit record,
   *   - the legacy Payment flipped to SUCCESS at the settled amount — what the
   *     roster and the revenue report still read on un-flipped clinics.
   *
   * Never touches the token or the queue. Idempotent: a second collect on an
   * already-settled booking returns the first settlement instead of charging
   * twice.
   */
  async collectPayment(
    clinicId: string,
    bookingId: string,
    opts: CollectPaymentInput & { actorId?: string } = {},
  ): Promise<CollectPaymentView> {
    const mode: DeskPaymentMode = opts.mode ?? 'CASH';
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        doctor: { select: { clinicId: true } },
        payment: {
          select: { id: true, amount: true, status: true, deskMode: true },
        },
      },
    });
    if (!booking) {
      // Read cutover: an encounterId-backed roster row settles via OpPayment.
      return this.collectPaymentEncounter(clinicId, bookingId, mode, opts);
    }
    if (booking.doctor.clinicId !== clinicId) {
      throw new ForbiddenException('booking belongs to another clinic');
    }
    if (!booking.payment) {
      throw new NotFoundException('no payment is attached to this booking');
    }
    if (booking.payment.status === PaymentStatus.SUCCESS) {
      // Already settled — report what was actually taken, don't re-charge.
      return {
        bookingId: booking.id,
        paid: true,
        amountPaise: booking.payment.amount,
        mode: (booking.payment.deskMode as DeskPaymentMode | null) ?? mode,
      };
    }

    // WAIVED is free by definition; anything else is the amount the desk keyed
    // in (concession / part payment), defaulting to the full fee on the row.
    const amountPaise =
      mode === 'WAIVED' ? 0 : (opts.amountPaise ?? booking.payment.amount);

    // Audit record on the new engine, when this booking was mirrored to one.
    const encounterId = await this.encounterIdFor(bookingId);
    if (encounterId) {
      await this.settleEncounterOnce(encounterId, mode, amountPaise, opts.actorId);
    }

    await this.prisma.payment.update({
      where: { id: booking.payment.id },
      data: {
        status: PaymentStatus.SUCCESS,
        amount: amountPaise,
        deskMode: mode as OpPaymentMode,
        collectedById: opts.actorId ?? null,
        collectedAt: new Date(),
      },
    });
    return { bookingId: booking.id, paid: true, amountPaise, mode };
  }

  /**
   * Desk payment collection for an Encounter-backed roster row: settle a decoupled
   * OpPayment — never gates a token. Idempotent: an existing SUCCESS desk payment
   * is returned rather than double-charged.
   */
  private async collectPaymentEncounter(
    clinicId: string,
    encounterId: string,
    mode: DeskPaymentMode,
    opts: CollectPaymentInput & { actorId?: string },
  ): Promise<CollectPaymentView> {
    const enc = await this.prisma.encounter.findUnique({
      where: { id: encounterId },
      select: { id: true, clinicId: true },
    });
    if (!enc) throw new NotFoundException('booking not found');
    if (enc.clinicId !== clinicId) {
      throw new ForbiddenException('booking belongs to another clinic');
    }
    const existing = await this.prisma.opPayment.findFirst({
      where: { encounterId, status: PaymentStatus.SUCCESS },
      select: { amount: true, mode: true },
    });
    if (existing) {
      await this.settleLegacyTwin(encounterId, {
        mode: existing.mode as DeskPaymentMode,
        amountPaise: existing.amount,
        actorId: opts.actorId,
      });
      return {
        bookingId: encounterId,
        paid: true,
        amountPaise: existing.amount,
        mode: existing.mode as DeskPaymentMode,
      };
    }
    const pay = await this.opPayments.settleAtDesk(
      encounterId,
      mode as OpPaymentMode,
      {
        // WAIVED settles 0 inside the payment service; for the rest, undefined
        // means "the configured fee for this token series".
        amount: opts.amountPaise,
        actorId: opts.actorId ?? 'reception',
      },
    );
    await this.settleLegacyTwin(encounterId, {
      mode: pay.mode as DeskPaymentMode,
      amountPaise: pay.amount,
      actorId: opts.actorId,
    });
    return {
      bookingId: encounterId,
      paid: true,
      amountPaise: pay.amount,
      mode: pay.mode as DeskPaymentMode,
    };
  }

  /**
   * Settle the legacy Payment attached to the booking this encounter mirrors.
   *
   * On a read-flipped clinic the desk settles against an encounterId, but the
   * visit usually still has a legacy Booking + Payment behind it — the revenue
   * report and every un-flipped surface read that row. Leaving it CREATED would
   * park an unpaid balance on a visit the patient has already paid for. Silent
   * on failure for the same reason the mirror is: money is already recorded on
   * the new engine, and a bookkeeping echo must never fail the collection.
   */
  private async settleLegacyTwin(
    encounterId: string,
    settled: { mode: DeskPaymentMode; amountPaise: number; actorId?: string },
  ): Promise<void> {
    try {
      const bookingId = await this.legacyBookingIdFor(encounterId);
      if (!bookingId) return;
      const booking = await this.prisma.booking.findUnique({
        where: { id: bookingId },
        select: { payment: { select: { id: true, status: true } } },
      });
      if (!booking?.payment || booking.payment.status === PaymentStatus.SUCCESS) {
        return;
      }
      await this.prisma.payment.update({
        where: { id: booking.payment.id },
        data: {
          status: PaymentStatus.SUCCESS,
          amount: settled.amountPaise,
          deskMode: settled.mode as OpPaymentMode,
          collectedById: settled.actorId ?? null,
          collectedAt: new Date(),
        },
      });
    } catch {
      // best effort — see the doc comment
    }
  }

  /** The legacy booking an encounter mirrors, from either side of the link. */
  private async legacyBookingIdFor(encounterId: string): Promise<string | null> {
    const enc = await this.prisma.encounter.findUnique({
      where: { id: encounterId },
      select: { legacyBookingId: true },
    });
    if (enc?.legacyBookingId) return enc.legacyBookingId;
    const reg = await this.prisma.registration.findFirst({
      where: { encounterId },
      select: { channelMeta: true },
    });
    const meta = reg?.channelMeta as { legacyBookingId?: string } | null;
    return meta?.legacyBookingId ?? null;
  }

  /** Write the OpPayment audit row unless this encounter already has one. */
  private async settleEncounterOnce(
    encounterId: string,
    mode: DeskPaymentMode,
    amountPaise: number,
    actorId?: string,
  ): Promise<void> {
    const existing = await this.prisma.opPayment.findFirst({
      where: { encounterId, status: PaymentStatus.SUCCESS },
      select: { id: true },
    });
    if (existing) return;
    await this.opPayments.settleAtDesk(encounterId, mode as OpPaymentMode, {
      amount: amountPaise,
      actorId: actorId ?? 'reception',
    });
  }

  /**
   * The encounter mirroring a legacy booking. A desk-created one carries the id
   * in Encounter.legacyBookingId; a mirror-created one (voice/app) carries it in
   * Registration.channelMeta.legacyBookingId — check both, same as VoiceService.
   */
  private async encounterIdFor(bookingId: string): Promise<string | null> {
    const direct = await this.prisma.encounter.findFirst({
      where: { legacyBookingId: bookingId },
      select: { id: true },
    });
    if (direct) return direct.id;
    const reg = await this.prisma.registration.findFirst({
      where: { channelMeta: { path: ['legacyBookingId'], equals: bookingId } },
      select: { encounterId: true },
    });
    return reg?.encounterId ?? null;
  }

  /** Doctors in the caller's clinic, for the queue-monitoring picker. */
  async listDoctors(clinicId: string): Promise<ReceptionDoctorView[]> {
    const doctors = await this.prisma.doctor.findMany({
      where: { clinicId },
      select: {
        id: true,
        name: true,
        specialization: true,
        avgConsultMinutes: true,
      },
      orderBy: { name: 'asc' },
    });
    return doctors.map(toReceptionDoctorView);
  }

  async setArrived(
    clinicId: string,
    bookingId: string,
    arrived: boolean,
  ): Promise<CheckInView> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, checkedInAt: true, doctor: { select: { clinicId: true } } },
    });
    if (!booking) {
      // Read cutover: the id may be a new-engine encounterId (roster rows without
      // a legacy booking carry the encounterId as bookingId). Route to the token
      // engine's check-in so the reception app keeps working unchanged.
      return this.setArrivedEncounter(clinicId, bookingId, arrived);
    }
    if (booking.doctor.clinicId !== clinicId) {
      throw new ForbiddenException('booking belongs to another clinic');
    }

    // Idempotent: a repeated check-in preserves the ORIGINAL arrival time (don't
    // overwrite to "now"); a repeated clear stays null. Only a real transition
    // writes. No Redis, no queue side effects.
    let next: Date | null;
    if (arrived) {
      next = booking.checkedInAt ?? new Date();
    } else {
      next = null;
    }

    const updated = await this.prisma.booking.update({
      where: { id: bookingId },
      data: { checkedInAt: next },
      select: { id: true, checkedInAt: true },
    });
    return toCheckInView(updated);
  }

  /**
   * New-engine check-in for a roster row backed by an Encounter (not a legacy
   * Booking). Forward-only: the token engine's state machine has no "un-check-in",
   * so clearing arrival is a 409 rather than a silent lie. Idempotent on re-check.
   */
  private async setArrivedEncounter(
    clinicId: string,
    encounterId: string,
    arrived: boolean,
  ): Promise<CheckInView> {
    const enc = await this.prisma.encounter.findUnique({
      where: { id: encounterId },
      select: { id: true, clinicId: true },
    });
    if (!enc) throw new NotFoundException('booking not found');
    if (enc.clinicId !== clinicId) {
      throw new ForbiddenException('booking belongs to another clinic');
    }
    if (!arrived) {
      throw new ConflictException('check-in cannot be undone in the token engine');
    }
    // Marking a patient arrived at the desk processes them fully into the new
    // queue: check in (issuing the token if not already issued) then enqueue.
    // All steps are idempotent, so a token-holder already in the queue is a no-op.
    const result = await this.checkInEngine.checkIn(encounterId, CheckInMethod.DESK, {
      checkedInBy: 'reception',
      issueToken: true,
    });
    await this.opQueue.enqueue(encounterId).catch(() => undefined);
    return {
      id: encounterId,
      checkedInAt: result.checkIn.checkedInAt.toISOString(),
      arrived: true,
    };
  }
}
