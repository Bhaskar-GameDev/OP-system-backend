import { Injectable } from '@nestjs/common';
import { EncounterStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { StoredEvent, DomainEventType } from '../event-store/domain-event.types';

/**
 * CQRS projector (ARCHITECTURE.md §12.2, Phase 14). Folds the domain event stream
 * into the denormalized QueueReadModel. Idempotent per event, so a replay from
 * zero rebuilds the read model exactly (Phase 13: event replay).
 */
@Injectable()
export class ProjectionService {
  constructor(private readonly prisma: PrismaService) {}

  /** Apply a single event to the read model. */
  async apply(event: StoredEvent): Promise<void> {
    const encounterId =
      event.streamType === 'Encounter'
        ? event.streamId
        : (event.payload.encounterId as string | undefined);
    if (!encounterId) return;

    switch (event.type) {
      case DomainEventType.EncounterCreated:
        await this.onCreated(encounterId, event);
        break;
      case DomainEventType.PatientCheckedIn:
        await this.setStatus(encounterId, EncounterStatus.CHECKED_IN);
        break;
      case DomainEventType.TokenIssued:
        await this.update(encounterId, {
          tokenNumber: event.payload.displayNumber as string,
          category: event.payload.seriesCode as string,
          status: EncounterStatus.TOKEN_ISSUED,
        });
        break;
      case DomainEventType.QueueEntered:
        await this.update(encounterId, {
          opSessionId: event.payload.opSessionId as string,
          orderKey: event.payload.orderKey as number,
          category: (event.payload.category as string) ?? undefined,
          status: EncounterStatus.WAITING,
        });
        break;
      case DomainEventType.PatientCalled:
        await this.setStatus(encounterId, EncounterStatus.CALLED);
        break;
      case DomainEventType.PatientSkipped:
        await this.setStatus(encounterId, EncounterStatus.SKIPPED);
        break;
      case DomainEventType.PatientRecalled:
        await this.setStatus(encounterId, EncounterStatus.WAITING);
        break;
      case DomainEventType.NoShowMarked:
        await this.setStatus(encounterId, EncounterStatus.NO_SHOW);
        break;
      case DomainEventType.EncounterTransferred:
        await this.setStatus(encounterId, EncounterStatus.TRANSFERRED);
        break;
      case DomainEventType.DoctorOverrideStarted:
        await this.update(encounterId, {
          status: EncounterStatus.IN_CONSULTATION,
          isOverride: true,
        });
        break;
      case DomainEventType.ConsultationStarted:
        await this.update(encounterId, {
          status: EncounterStatus.IN_CONSULTATION,
          isEmergency: Boolean(event.payload.emergency),
        });
        break;
      case DomainEventType.ConsultationPaused:
        await this.setStatus(encounterId, EncounterStatus.PAUSED);
        break;
      case DomainEventType.ConsultationResumed:
        await this.setStatus(encounterId, EncounterStatus.IN_CONSULTATION);
        break;
      case DomainEventType.ConsultationCompleted:
      case DomainEventType.EmergencyEnded:
        await this.setStatus(encounterId, EncounterStatus.COMPLETED);
        break;
      case DomainEventType.EmergencyStarted:
        await this.update(encounterId, {
          status: EncounterStatus.IN_CONSULTATION,
          isEmergency: true,
        });
        break;
      default:
        break;
    }
  }

  private async onCreated(encounterId: string, event: StoredEvent): Promise<void> {
    const enc = await this.prisma.encounter.findUnique({
      where: { id: encounterId },
      select: { clinicId: true, doctorId: true, patientId: true, status: true },
    });
    if (!enc) return;
    const patient = await this.prisma.patient.findUnique({
      where: { id: enc.patientId },
      select: { name: true },
    });
    await this.prisma.queueReadModel.upsert({
      where: { encounterId },
      create: {
        encounterId,
        clinicId: enc.clinicId,
        doctorId: enc.doctorId,
        patientName: patient?.name ?? 'Patient',
        status: enc.status,
        source: (event.metadata?.source as string) ?? null,
      },
      update: {},
    });
  }

  private async setStatus(
    encounterId: string,
    status: EncounterStatus,
  ): Promise<void> {
    await this.update(encounterId, { status });
  }

  private async update(
    encounterId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    // Upsert-safe: if the create event was missed (partial replay), synthesize a
    // minimal row from the encounter so projections never silently drop a patient.
    const exists = await this.prisma.queueReadModel.findUnique({
      where: { encounterId },
      select: { encounterId: true },
    });
    if (!exists) {
      const enc = await this.prisma.encounter.findUnique({
        where: { id: encounterId },
        select: { clinicId: true, doctorId: true, patientId: true },
      });
      if (!enc) return;
      const patient = await this.prisma.patient.findUnique({
        where: { id: enc.patientId },
        select: { name: true },
      });
      await this.prisma.queueReadModel.create({
        data: {
          encounterId,
          clinicId: enc.clinicId,
          doctorId: enc.doctorId,
          patientName: patient?.name ?? 'Patient',
          status: EncounterStatus.REGISTERED,
        },
      });
    }
    await this.prisma.queueReadModel.update({
      where: { encounterId },
      data,
    });
  }
}
