import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { BookingSource, BookingStatus, SessionType } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ConsultationService } from '../queue-engine/consultation.service';
import { SessionKey, TokenSource } from '../queue-engine/token.service';
import {
  BookingRosterView,
  CheckInView,
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
        patient: { select: { name: true } },
      },
      orderBy: { tokenNumber: 'asc' },
    });
    return rows.map(toBookingRosterView);
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
    if (!booking) throw new NotFoundException('booking not found');
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
}
