import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BookingSource, BookingStatus, Prisma, SessionType } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ConsultationService } from '../queue-engine/consultation.service';
import { QueueService } from '../queue-engine/queue.service';
import { SessionKey, TokenSource } from '../queue-engine/token.service';
import {
  BookDto,
  CallLogDto,
  CancelAppointmentDto,
  DoctorAvailabilityView,
  LookupAppointmentsDto,
  SearchAvailabilityDto,
  SessionAvailabilityView,
  VoiceAppointmentView,
  VoiceBookingView,
} from './voice.dto';

const ALL_SESSIONS: SessionType[] = [SessionType.MORNING, SessionType.EVENING];
const MAX_DOCTORS = 5;

// Live (cancellable / upcoming) states — a voice caller can only act on these.
const LIVE: BookingStatus[] = [
  BookingStatus.PENDING_PAYMENT,
  BookingStatus.BOOKED,
  BookingStatus.ACTIVE,
];

/**
 * Backend for the standalone voice agent. This is the ONLY place the voice
 * channel touches the database / queue engine — the agent process never holds a
 * Prisma or Redis connection itself, so the atomic token+queue primitives have a
 * single implementation (no duplicated counter logic in a second process).
 *
 * A VOICE booking is created exactly like a reception WALK_IN: a real BOOKED
 * booking with no payment, token issued + enqueued through the same atomic
 * primitive (ConsultationService.enqueueBooking). It is therefore
 * indistinguishable from app/walk-in bookings for check-in / no-show / DONE.
 * `source = VOICE` (never the token prefix) is the analytics truth.
 */
@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly consult: ConsultationService,
    private readonly queue: QueueService,
    private readonly config: ConfigService,
  ) {}

  // ── clinic resolution ──────────────────────────────────────────────────────

  /**
   * Resolve which clinic a call belongs to. Prefer the dialed DID (Clinic.voiceDid);
   * fall back to VOICE_DEFAULT_CLINIC_ID for single-tenant / dev. Throws if neither
   * resolves — we never guess a clinic.
   */
  private async resolveClinicId(didNumber?: string): Promise<string> {
    if (didNumber) {
      const clinic = await this.prisma.clinic.findUnique({
        where: { voiceDid: didNumber },
        select: { id: true },
      });
      if (clinic) return clinic.id;
    }
    const fallback = this.config.get<string>('VOICE_DEFAULT_CLINIC_ID');
    if (fallback) return fallback;
    throw new NotFoundException(
      `no clinic mapped to DID "${didNumber ?? '(none)'}" and no VOICE_DEFAULT_CLINIC_ID set`,
    );
  }

  // ── availability search ─────────────────────────────────────────────────────

  /**
   * Find doctors at the clinic matching a (possibly colloquial) specialty and
   * report live queue load per session for the requested date. There are no
   * fixed time-slots in this system — availability is a MORNING/EVENING session
   * plus how many patients are currently waiting.
   */
  async searchAvailability(dto: SearchAvailabilityDto): Promise<{
    clinicId: string;
    clinicName: string;
    sessionDate: string;
    doctors: DoctorAvailabilityView[];
  }> {
    const clinicId = await this.resolveClinicId(dto.didNumber);
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { name: true },
    });
    if (!clinic) throw new NotFoundException('clinic not found');

    const doctors = await this.prisma.doctor.findMany({
      where: { clinicId },
      select: {
        id: true,
        name: true,
        specialization: true,
        specialtyAliases: true,
        consultationFee: true,
        avgConsultMinutes: true,
      },
    });

    const term = normalizeSpecialty(dto.specialty);
    const matched = doctors.filter((d) => specialtyMatches(term, d.specialization, d.specialtyAliases));

    const sessionsToReport = dto.sessionType ? [dto.sessionType] : ALL_SESSIONS;

    const views: DoctorAvailabilityView[] = [];
    for (const d of matched.slice(0, MAX_DOCTORS)) {
      const sessions: SessionAvailabilityView[] = [];
      for (const sessionType of sessionsToReport) {
        const session: SessionKey = {
          doctorId: d.id,
          sessionDate: dto.sessionDate,
          sessionType,
        };
        const waiting = (await this.queue.listWithScores(session)).length;
        sessions.push({
          sessionType,
          waiting,
          etaMinutes: waiting * d.avgConsultMinutes,
        });
      }
      views.push({
        doctorId: d.id,
        doctorName: d.name,
        specialization: d.specialization,
        consultationFee: d.consultationFee,
        sessions,
      });
    }

    return {
      clinicId,
      clinicName: clinic.name,
      sessionDate: dto.sessionDate,
      doctors: views,
    };
  }

  // ── booking ─────────────────────────────────────────────────────────────────

  /**
   * Create a VOICE booking. Mirrors ReceptionService.registerWalkIn exactly,
   * but with source = VOICE and TokenSource.VOICE (shares the "A" counter with
   * app bookings). No payment row — confirmation is immediate, like a walk-in.
   */
  async book(dto: BookDto): Promise<VoiceBookingView> {
    const clinicId = await this.resolveClinicId(dto.didNumber);

    const doctor = await this.prisma.doctor.findUnique({
      where: { id: dto.doctorId },
      select: { id: true, name: true, clinicId: true },
    });
    if (!doctor) throw new NotFoundException('doctor not found');
    if (doctor.clinicId !== clinicId) {
      throw new BadRequestException('doctor belongs to another clinic');
    }

    // ensure patient by mobile; learn the name if we now have one
    const patient = await this.prisma.patient.upsert({
      where: { mobile: dto.patientPhone },
      create: { mobile: dto.patientPhone, name: dto.patientName ?? '' },
      update: {},
      select: { id: true, name: true },
    });
    if (!patient.name && dto.patientName) {
      await this.prisma.patient.update({
        where: { id: patient.id },
        data: { name: dto.patientName },
      });
    }

    const booking = await this.prisma.booking.create({
      data: {
        patientId: patient.id,
        doctorId: dto.doctorId,
        source: BookingSource.VOICE,
        sessionDate: new Date(dto.sessionDate),
        sessionType: dto.sessionType,
        status: BookingStatus.BOOKED,
      },
      select: { id: true },
    });

    const session: SessionKey = {
      doctorId: dto.doctorId,
      sessionDate: dto.sessionDate,
      sessionType: dto.sessionType,
    };

    // atomic token issue + enqueue (+ promote to ACTIVE if the queue was empty)
    const entry = await this.consult.enqueueBooking(TokenSource.VOICE, session, booking.id);

    const updated = await this.prisma.booking.update({
      where: { id: booking.id },
      data: { tokenNumber: entry.tokenNumber },
      select: { id: true, tokenNumber: true, status: true },
    });

    this.logger.log(
      `VOICE booking ${updated.id} -> token ${updated.tokenNumber} (doctor ${doctor.name}, ${dto.sessionType} ${dto.sessionDate}, call ${dto.callSid ?? 'n/a'})`,
    );

    return {
      bookingId: updated.id,
      tokenNumber: updated.tokenNumber ?? entry.tokenNumber,
      doctorId: doctor.id,
      doctorName: doctor.name,
      sessionDate: dto.sessionDate,
      sessionType: dto.sessionType,
      status: updated.status,
    };
  }

  // ── lookup (for cancel / reschedule flows) ───────────────────────────────────

  /** Upcoming, still-live bookings for a caller (by mobile), most imminent first. */
  async findAppointments(dto: LookupAppointmentsDto): Promise<VoiceAppointmentView[]> {
    const clinicId = await this.resolveClinicId(dto.didNumber).catch(() => null);

    const patient = await this.prisma.patient.findUnique({
      where: { mobile: dto.patientPhone },
      select: { id: true },
    });
    if (!patient) return [];

    const where: Prisma.BookingWhereInput = {
      patientId: patient.id,
      status: { in: LIVE },
      ...(clinicId ? { doctor: { clinicId } } : {}),
    };

    const rows = await this.prisma.booking.findMany({
      where,
      select: {
        id: true,
        doctorId: true,
        sessionDate: true,
        sessionType: true,
        tokenNumber: true,
        status: true,
        doctor: { select: { name: true, specialization: true } },
      },
      orderBy: [{ sessionDate: 'asc' }, { createdAt: 'asc' }],
    });

    return rows.map((r) => ({
      appointmentId: r.id,
      doctorId: r.doctorId,
      doctorName: r.doctor.name,
      specialization: r.doctor.specialization,
      sessionDate: toISODate(r.sessionDate),
      sessionType: r.sessionType,
      tokenNumber: r.tokenNumber,
      status: r.status,
    }));
  }

  // ── cancellation ─────────────────────────────────────────────────────────────

  /**
   * Cancel a VOICE booking: mark CANCELLED and remove it from the live queue via
   * the same atomic primitive used elsewhere (cancelDequeue: pops + promotes the
   * next patient if it was ACTIVE). No refund logic — voice bookings carry no
   * payment row.
   */
  async cancel(dto: CancelAppointmentDto): Promise<VoiceAppointmentView> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: dto.appointmentId },
      select: {
        id: true,
        doctorId: true,
        sessionDate: true,
        sessionType: true,
        tokenNumber: true,
        status: true,
        doctor: { select: { name: true, specialization: true } },
      },
    });
    if (!booking) throw new NotFoundException('appointment not found');
    if (!LIVE.includes(booking.status)) {
      throw new ConflictException(`appointment is ${booking.status}, cannot cancel`);
    }

    const session: SessionKey = {
      doctorId: booking.doctorId,
      sessionDate: toISODate(booking.sessionDate),
      sessionType: booking.sessionType,
    };

    // remove from the Redis queue first (idempotent / no-op if not queued)
    if (booking.tokenNumber) {
      await this.consult.cancelDequeue(session, booking.tokenNumber);
    }

    const updated = await this.prisma.booking.update({
      where: { id: booking.id },
      data: { status: BookingStatus.CANCELLED },
      select: { status: true },
    });

    this.logger.log(`VOICE cancel ${booking.id} (token ${booking.tokenNumber ?? 'n/a'})`);

    return {
      appointmentId: booking.id,
      doctorId: booking.doctorId,
      doctorName: booking.doctor.name,
      specialization: booking.doctor.specialization,
      sessionDate: toISODate(booking.sessionDate),
      sessionType: booking.sessionType,
      tokenNumber: booking.tokenNumber,
      status: updated.status,
    };
  }

  // ── call logging ─────────────────────────────────────────────────────────────

  /** Persist (or update) the full call record. Keyed by Vobiz callSid. */
  async saveCallLog(dto: CallLogDto): Promise<{ id: string }> {
    const clinicId = await this.resolveClinicId(dto.didNumber).catch(() => null);

    const data = {
      clinicId,
      callerPhone: dto.callerPhone,
      didNumber: dto.didNumber ?? '',
      language: dto.language ?? null,
      transcript: (dto.transcript ?? null) as Prisma.InputJsonValue,
      slots: (dto.slots ?? null) as Prisma.InputJsonValue,
      bookingId: dto.bookingId ?? null,
      outcome: dto.outcome ?? null,
      duration: dto.duration ?? null,
    };

    const row = await this.prisma.callLog.upsert({
      where: { callSid: dto.callSid },
      create: { callSid: dto.callSid, ...data },
      update: data,
      select: { id: true },
    });
    return row;
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────────

/** Lowercase, strip underscores/hyphens to spaces, collapse whitespace. */
function normalizeSpecialty(s: string): string {
  return s
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Match a normalized request term against a doctor's canonical specialization
 * and its alias list. Bidirectional `includes` so "skin" matches "skin doctor"
 * and "general medicine" matches "general". Aliases are matched verbatim too
 * (covers Telugu/Hindi terms the agent may pass through).
 */
function specialtyMatches(
  term: string,
  specialization: string | null,
  aliases: string[],
): boolean {
  if (!term) return false;
  const spec = specialization ? normalizeSpecialty(specialization) : '';
  if (spec && (spec.includes(term) || term.includes(spec))) return true;
  return aliases.some((a) => {
    const na = normalizeSpecialty(a);
    return na === term || na.includes(term) || term.includes(na);
  });
}

/** Prisma @db.Date comes back as a Date at UTC midnight → 'YYYY-MM-DD'. */
function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
