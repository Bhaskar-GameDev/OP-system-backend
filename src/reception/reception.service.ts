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
  CollectPaymentView,
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
      select: { clinicId: true },
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
    if (!patient.name && input.name) {
      await this.prisma.patient.update({
        where: { id: patient.id },
        data: { name: input.name },
      });
    }

    // real booking row — BOOKED so the promote guard (BOOKED -> ACTIVE) holds
    const booking = await this.prisma.booking.create({
      data: {
        patientId: patient.id,
        doctorId: input.doctorId,
        source: BookingSource.WALK_IN,
        sessionDate: new Date(input.sessionDate),
        sessionType: input.sessionType as SessionType,
        status: BookingStatus.BOOKED,
      },
      select: { id: true },
    });

    const session: SessionKey = {
      doctorId: input.doctorId,
      sessionDate: input.sessionDate,
      sessionType: input.sessionType,
    };

    // atomic token issue + enqueue (+ promote if front) + live broadcast
    const entry = await this.consult.enqueueBooking(
      TokenSource.WALK_IN,
      session,
      booking.id,
    );

    // write the display token back, exactly like payment-confirm
    const updated = await this.prisma.booking.update({
      where: { id: booking.id },
      data: { tokenNumber: entry.tokenNumber },
      select: { id: true, patientId: true, tokenNumber: true, status: true },
    });

    // Dual-write to the new engine (Task 2). The walk-in patient is at the desk,
    // so this is the combined path: register + check-in + token + enqueue. Best
    // effort — never blocks or fails the legacy booking above.
    await this.mirror.mirror({
      source: RegistrationSource.RECEPTION,
      doctorId: input.doctorId,
      patientId: updated.patientId,
      mobile: input.mobile,
      name: input.name,
      serviceDate: input.sessionDate,
      idempotencyKey: booking.id,
      legacyBookingId: booking.id,
      actorId: clinicId,
      present: true,
    });

    return {
      bookingId: updated.id,
      patientId: updated.patientId,
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
        payment: { select: { status: true } },
        patient: { select: { name: true } },
      },
      orderBy: { tokenNumber: 'asc' },
    });
    return rows.map(toBookingRosterView);
  }

  /**
   * Collect a pay-at-desk payment (cash/UPI taken at reception) for a voice
   * booking. Flips the attached Payment to SUCCESS — the booking already holds a
   * token, so nothing about the queue changes. Clinic-scoped like everything else
   * here; idempotent (a second collect on an already-paid booking is a no-op).
   */
  async collectPayment(
    clinicId: string,
    bookingId: string,
  ): Promise<CollectPaymentView> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        doctor: { select: { clinicId: true } },
        payment: { select: { id: true, amount: true, status: true } },
      },
    });
    if (!booking) {
      // Read cutover: an encounterId-backed roster row settles via OpPayment.
      return this.collectPaymentEncounter(clinicId, bookingId);
    }
    if (booking.doctor.clinicId !== clinicId) {
      throw new ForbiddenException('booking belongs to another clinic');
    }
    if (!booking.payment) {
      throw new NotFoundException('no payment is attached to this booking');
    }
    if (booking.payment.status !== PaymentStatus.SUCCESS) {
      await this.prisma.payment.update({
        where: { id: booking.payment.id },
        data: { status: PaymentStatus.SUCCESS },
      });
    }
    return { bookingId: booking.id, paid: true, amountPaise: booking.payment.amount };
  }

  /**
   * Desk payment collection for an Encounter-backed roster row: settle a decoupled
   * OpPayment (CASH) — never gates a token. Idempotent: an existing SUCCESS desk
   * payment is returned rather than double-charged.
   */
  private async collectPaymentEncounter(
    clinicId: string,
    encounterId: string,
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
      select: { amount: true },
    });
    if (existing) {
      return { bookingId: encounterId, paid: true, amountPaise: existing.amount };
    }
    const pay = await this.opPayments.settleAtDesk(encounterId, OpPaymentMode.CASH, {
      actorId: 'reception',
    });
    return { bookingId: encounterId, paid: true, amountPaise: pay.amount };
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
