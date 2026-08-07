import { Injectable } from '@nestjs/common';
import {
  BookingSource,
  BookingStatus,
  EncounterStatus,
  RegistrationSource,
  SessionType,
} from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { OpConfigService } from '../config-engine/op-config.service';
import { EtaService } from '../queue-engine/eta.service';
import { DoctorQueueEntry, DoctorQueueView } from './doctor.dto';

/**
 * Read-cutover compatibility for the doctor's live queue, the third and last
 * surface to gain a flag (roster and patientStatus already have theirs). Serves
 * `/doctor/queue` from the NEW QueueReadModel projection while preserving the
 * legacy `DoctorQueueView` wire shape, so the doctor app needs no change.
 *
 * This exists because a cutover that cannot include the doctor is not a cutover.
 * With only roster + patientStatus flippable, the desk and the patient app would
 * read the new engine while the doctor's screen still read the old one — the two
 * halves of the same consultation disagreeing in the same room. Flipping all
 * three together is the only safe unit.
 *
 * Gated per clinic by `reads.cutover.doctorQueue` (default FALSE), same as the
 * others: reversible, and every un-flipped clinic keeps the legacy read.
 *
 * Known reduction, shared with the roster: the new model has one session per
 * doctor per day, so `sessionType` is echoed back from the request rather than
 * filtered on — a flipped doctor sees the whole day's queue.
 */
@Injectable()
export class OpQueueCompatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: OpConfigService,
    private readonly eta: EtaService,
  ) {}

  /** Is the new-model doctor-queue read enabled for this doctor's clinic? */
  async enabled(doctorId: string): Promise<boolean> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { clinicId: true },
    });
    if (!doctor) return false;
    return this.config.get(
      'reads.cutover.doctorQueue',
      { clinicId: doctor.clinicId },
      false,
    );
  }

  /** The doctor's live queue, built from the projection in the legacy shape. */
  async queue(
    doctorId: string,
    sessionType: SessionType,
    sessionDate: string,
  ): Promise<DoctorQueueView> {
    // IN_CONSULTATION is the new engine's ACTIVE: that patient is rank 0, ahead
    // of the WAITING line, exactly as the legacy queue's promoted front token is.
    const [active, waiting] = await Promise.all([
      this.prisma.queueReadModel.findFirst({
        where: { doctorId, status: EncounterStatus.IN_CONSULTATION },
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.queueReadModel.findMany({
        where: { doctorId, status: EncounterStatus.WAITING },
        orderBy: { orderKey: 'asc' },
      }),
    ]);

    const ordered = active ? [active, ...waiting] : waiting;
    if (ordered.length === 0) {
      return {
        doctorId,
        sessionDate,
        sessionType,
        activeToken: null,
        total: 0,
        entries: [],
      };
    }

    // Same ETA arithmetic the legacy board uses (position * avg), so a flipped
    // clinic sees the same numbers move at the same rate.
    const avg = await this.eta.avgConsultMinutes(doctorId);

    // Origin comes from the Registration source; the legacy view's `source` and
    // `bookingType` both derive from it.
    const encounterIds = ordered.map((r) => r.encounterId);
    const [regs, encounters] = await Promise.all([
      this.prisma.registration.findMany({
        where: { encounterId: { in: encounterIds } },
        select: { encounterId: true, source: true },
      }),
      this.prisma.encounter.findMany({
        where: { id: { in: encounterIds } },
        select: { id: true, legacyBookingId: true },
      }),
    ]);
    const sourceBy = new Map(regs.map((r) => [r.encounterId, r.source]));
    const legacyBy = new Map(encounters.map((e) => [e.id, e.legacyBookingId]));

    const entries: DoctorQueueEntry[] = ordered.map((row, i) => {
      const source = mapSource(sourceBy.get(row.encounterId));
      return {
        tokenNumber: row.tokenNumber ?? '',
        position: i + 1,
        patientsAhead: i,
        etaMinutes: i * avg,
        patientName: row.patientName && row.patientName.length > 0 ? row.patientName : null,
        // The doctor app opens notes by this id; fall back to the encounterId so
        // a new-native encounter is still addressable (op note endpoints accept it).
        bookingId: legacyBy.get(row.encounterId) ?? row.encounterId,
        source,
        bookingType: source === BookingSource.WALK_IN ? 'WALK_IN' : 'ONLINE',
        status: mapStatus(row.status),
        isActive: i === 0,
      };
    });

    return {
      doctorId,
      sessionDate,
      sessionType,
      activeToken: entries[0]?.tokenNumber ?? null,
      total: entries.length,
      entries,
    };
  }
}

/** EncounterStatus → the legacy BookingStatus the doctor app expects. */
function mapStatus(s: EncounterStatus): BookingStatus {
  switch (s) {
    case EncounterStatus.IN_CONSULTATION:
    case EncounterStatus.PAUSED:
      return BookingStatus.ACTIVE;
    case EncounterStatus.COMPLETED:
      return BookingStatus.COMPLETED;
    case EncounterStatus.NO_SHOW:
      return BookingStatus.NO_SHOW;
    case EncounterStatus.CANCELLED:
    case EncounterStatus.TRANSFERRED:
      return BookingStatus.CANCELLED;
    default:
      return BookingStatus.BOOKED;
  }
}

/** RegistrationSource → legacy BookingSource. */
function mapSource(s: RegistrationSource | undefined): BookingSource {
  switch (s) {
    case RegistrationSource.VOICE_AGENT:
      return BookingSource.VOICE;
    case RegistrationSource.RECEPTION:
      return BookingSource.WALK_IN;
    case RegistrationSource.APP:
    default:
      return BookingSource.APP;
  }
}
