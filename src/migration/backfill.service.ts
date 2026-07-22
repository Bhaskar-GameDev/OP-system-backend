import { Injectable, Logger } from '@nestjs/common';
import {
  BookingStatus,
  CheckInMethod,
  ConsultationState,
  EncounterStatus,
  RegistrationReason,
  RegistrationSource,
} from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { EventStoreService } from '../event-store/event-store.service';
import { DomainEventType } from '../event-store/domain-event.types';

/**
 * Legacy migration (ARCHITECTURE.md §Appendix A, Phase 15).
 *
 * Projects each legacy `Booking` god-row into the separated aggregates
 * (Encounter + Registration + CheckIn + Token + QueueEntry + Consultation) and
 * seeds the event stream, WITHOUT breaking the old table. Idempotent: keyed by
 * Encounter.legacyBookingId, so re-running never duplicates. This is the
 * projection-first cutover — new read models are built beside `bookings`, reads
 * move over, then the god-row is retired.
 */
@Injectable()
export class BackfillService {
  private readonly logger = new Logger(BackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventStoreService,
  ) {}

  /** Map a legacy BookingSource to the new RegistrationSource. */
  private mapSource(src: string): RegistrationSource {
    switch (src) {
      case 'WALK_IN':
        return RegistrationSource.RECEPTION;
      case 'VOICE':
        return RegistrationSource.VOICE_AGENT;
      case 'APP':
      default:
        return RegistrationSource.APP;
    }
  }

  /** Map a legacy BookingStatus to the new EncounterStatus. */
  private mapStatus(s: BookingStatus): EncounterStatus {
    switch (s) {
      case BookingStatus.PENDING_PAYMENT:
        return EncounterStatus.REGISTERED;
      case BookingStatus.BOOKED:
        return EncounterStatus.WAITING;
      case BookingStatus.ACTIVE:
        return EncounterStatus.IN_CONSULTATION;
      case BookingStatus.COMPLETED:
        return EncounterStatus.COMPLETED;
      case BookingStatus.NO_SHOW:
        return EncounterStatus.NO_SHOW;
      case BookingStatus.CANCELLED:
        return EncounterStatus.CANCELLED;
      case BookingStatus.EXPIRED:
      default:
        return EncounterStatus.CANCELLED;
    }
  }

  /**
   * Backfill all (or a batch of) legacy bookings. Returns counts. Ensures a
   * default TokenSeries exists per clinic touched (NORMAL_OP), since the legacy
   * model had no configurable series.
   */
  async run(opts: { batch?: number } = {}): Promise<{
    migrated: number;
    skipped: number;
  }> {
    const bookings = await this.prisma.booking.findMany({
      take: opts.batch ?? 1000,
      orderBy: { createdAt: 'asc' },
    });
    let migrated = 0;
    let skipped = 0;

    for (const b of bookings) {
      const already = await this.prisma.encounter.findUnique({
        where: { legacyBookingId: b.id },
        select: { id: true },
      });
      if (already) {
        skipped++;
        continue;
      }
      await this.migrateOne(b);
      migrated++;
    }
    this.logger.log(`backfill: migrated=${migrated} skipped=${skipped}`);
    return { migrated, skipped };
  }

  private async migrateOne(b: {
    id: string;
    patientId: string;
    doctorId: string;
    source: string;
    tokenNumber: string | null;
    sessionDate: Date;
    status: BookingStatus;
    checkedInAt: Date | null;
    consultationStartedAt: Date | null;
    consultationEndedAt: Date | null;
    createdAt: Date;
  }): Promise<void> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: b.doctorId },
      select: { clinicId: true },
    });
    if (!doctor) {
      this.logger.warn(`skip booking ${b.id}: doctor missing`);
      return;
    }
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: doctor.clinicId },
      select: { id: true, hospitalId: true },
    });
    if (!clinic) return;

    const series = await this.ensureDefaultSeries(clinic.id);
    const status = this.mapStatus(b.status);

    await this.prisma.$transaction(async (tx) => {
      const encounter = await tx.encounter.create({
        data: {
          patientId: b.patientId,
          hospitalId: clinic.hospitalId,
          clinicId: clinic.id,
          doctorId: b.doctorId,
          serviceDate: b.sessionDate,
          registrationReason: RegistrationReason.NEW,
          opCategoryId: series,
          status,
          legacyBookingId: b.id,
          createdAt: b.createdAt,
        },
      });
      await tx.registration.create({
        data: {
          encounterId: encounter.id,
          source: this.mapSource(b.source),
          channelMeta: { migratedFrom: b.id },
          createdAt: b.createdAt,
        },
      });
      if (b.checkedInAt) {
        await tx.checkIn.create({
          data: {
            encounterId: encounter.id,
            method: CheckInMethod.DESK,
            checkedInAt: b.checkedInAt,
          },
        });
      }
      if (b.tokenNumber) {
        await tx.token.create({
          data: {
            encounterId: encounter.id,
            seriesId: series,
            sequence: this.seqFromToken(b.tokenNumber),
            displayNumber: b.tokenNumber,
            issuedAt: b.checkedInAt ?? b.createdAt,
          },
        });
      }
      if (b.consultationStartedAt) {
        await tx.consultation.create({
          data: {
            encounterId: encounter.id,
            doctorId: b.doctorId,
            state:
              b.status === BookingStatus.COMPLETED
                ? ConsultationState.COMPLETED
                : ConsultationState.ACTIVE,
            startedAt: b.consultationStartedAt,
            endedAt: b.consultationEndedAt,
          },
        });
      }
      // Seed the event stream so replay/read models include migrated history.
      await this.events.append(
        {
          streamType: 'Encounter',
          streamId: encounter.id,
          type: DomainEventType.EncounterCreated,
          payload: {
            migrated: true,
            legacyBookingId: b.id,
            token: b.tokenNumber,
            finalStatus: b.status,
          },
          metadata: { source: this.mapSource(b.source), clinicId: clinic.id },
        },
        0,
        tx,
      );
    });
  }

  /** Get-or-create a clinic's default NORMAL_OP series (legacy had none). */
  private async ensureDefaultSeries(clinicId: string): Promise<string> {
    const existing = await this.prisma.tokenSeries.findFirst({
      where: { clinicId, code: 'NORMAL_OP' },
      select: { id: true },
    });
    if (existing) return existing.id;
    const created = await this.prisma.tokenSeries.create({
      data: {
        clinicId,
        code: 'NORMAL_OP',
        label: 'Normal OP',
        prefix: 'N',
      },
      select: { id: true },
    });
    return created.id;
  }

  private seqFromToken(token: string): number {
    const n = Number.parseInt(token.replace(/\D/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
  }
}
