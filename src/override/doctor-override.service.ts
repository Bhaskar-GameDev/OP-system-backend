import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Consultation,
  ConsultationState,
  Encounter,
  OverrideReason,
  RegistrationReason,
  RegistrationSource,
} from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { EventStoreService } from '../event-store/event-store.service';
import { DomainEventType } from '../event-store/domain-event.types';
import { StateMachineService } from '../state-machine/state-machine.service';
import { EncounterService } from '../encounters/encounter.service';
import { OpSessionService } from '../queue/op-session.service';

export interface OverrideInput {
  doctorId: string;
  patientId?: string;
  mobile?: string;
  name?: string;
  serviceDate: string;
  reason: OverrideReason;
  actorId?: string;
}

/**
 * Doctor Override (ARCHITECTURE.md §7, Phase 8).
 *
 * "Send this patient in." A first-class workflow, NOT a queue hack:
 *  - NO fake token — the override encounter never draws a number from the series.
 *  - Waiting tokens are NOT renumbered — the override consults in a separate lane.
 *  - Fully audited — DoctorOverrideStarted / DoctorOverrideCompleted.
 *  - Resume queue after — the normal queue is untouched, so the doctor's next
 *    "Call Next" continues exactly where it left off.
 *
 * It deliberately does NOT reuse the queue engine (the architecture requires this
 * to be its own business workflow).
 */
@Injectable()
export class DoctorOverrideService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventStoreService,
    private readonly sm: StateMachineService,
    private readonly encounters: EncounterService,
    private readonly sessions: OpSessionService,
  ) {}

  /** Consult an overridden patient now. Requires no other ACTIVE consultation. */
  async start(input: OverrideInput): Promise<{
    encounter: Encounter;
    consultation: Consultation;
  }> {
    // Reuse the registration pipeline for patient/tenant resolution + EncounterCreated.
    const base = await this.encounters.register({
      patientId: input.patientId,
      mobile: input.mobile,
      name: input.name,
      doctorId: input.doctorId,
      serviceDate: input.serviceDate,
      source: RegistrationSource.RECEPTION,
      reason: RegistrationReason.NEW,
      actorId: input.actorId,
      channelMeta: { override: true, overrideReason: input.reason },
    });

    // One ACTIVE consultation per doctor still holds.
    const active = await this.prisma.consultation.findFirst({
      where: { doctorId: input.doctorId, state: ConsultationState.ACTIVE },
    });
    if (active) {
      throw new ConflictException(
        'doctor already has an active consultation — complete it before override',
      );
    }

    // REGISTERED -> IN_CONSULTATION via the OVERRIDE_CONSULT transition (no token,
    // no queue entry -> the numeric line is never touched / renumbered).
    const nextStatus = this.sm.nextEncounter(base.status, 'OVERRIDE_CONSULT');
    const session = await this.sessions.getOrCreate(
      input.doctorId,
      base.clinicId,
      input.serviceDate,
    );

    return this.prisma.$transaction(async (tx) => {
      const encounter = await tx.encounter.update({
        where: { id: base.id },
        data: {
          status: nextStatus,
          override: true,
          overrideReason: input.reason,
        },
      });
      const consultation = await tx.consultation.create({
        data: {
          encounterId: base.id,
          doctorId: input.doctorId,
          state: ConsultationState.ACTIVE,
          startedAt: new Date(),
        },
      });
      await tx.opSession.update({
        where: { id: session.id },
        data: { activeConsultationId: consultation.id },
      });
      // Audit on the Encounter stream (v2, after EncounterCreated).
      const encVersion = await this.events.currentVersion(
        'Encounter',
        base.id,
        tx,
      );
      await this.events.append(
        {
          streamType: 'Encounter',
          streamId: base.id,
          type: DomainEventType.DoctorOverrideStarted,
          payload: { reason: input.reason, doctorId: input.doctorId },
          metadata: { actorId: input.actorId, clinicId: base.clinicId },
        },
        encVersion,
        tx,
      );
      // Consultation stream opens with ConsultationStarted.
      await this.events.append(
        {
          streamType: 'Consultation',
          streamId: consultation.id,
          type: DomainEventType.ConsultationStarted,
          payload: { encounterId: base.id, override: true },
          metadata: { actorId: input.actorId, clinicId: base.clinicId },
        },
        0,
        tx,
      );
      return { encounter, consultation };
    });
  }

  /** Complete an override consultation and free the doctor. */
  async complete(
    encounterId: string,
    opts: { actorId?: string } = {},
  ): Promise<Consultation> {
    const enc = await this.prisma.encounter.findUnique({
      where: { id: encounterId },
    });
    if (!enc || !enc.override) {
      throw new NotFoundException('override encounter not found');
    }
    const consult = await this.prisma.consultation.findFirst({
      where: { encounterId, state: ConsultationState.ACTIVE },
    });
    if (!consult) throw new NotFoundException('no active override consultation');
    const nextStatus = this.sm.nextEncounter(enc.status, 'COMPLETE');
    const nextConsult = this.sm.nextConsultation(consult.state, 'COMPLETE');

    return this.prisma.$transaction(async (tx) => {
      const cVersion = await this.events.currentVersion(
        'Consultation',
        consult.id,
        tx,
      );
      const updated = await tx.consultation.update({
        where: { id: consult.id },
        data: { state: nextConsult, endedAt: new Date() },
      });
      await tx.encounter.update({
        where: { id: enc.id },
        data: { status: nextStatus },
      });
      await tx.opSession.updateMany({
        where: { activeConsultationId: consult.id },
        data: { activeConsultationId: null },
      });
      await this.events.append(
        {
          streamType: 'Consultation',
          streamId: consult.id,
          type: DomainEventType.ConsultationCompleted,
          payload: { encounterId: enc.id, override: true },
          metadata: { actorId: opts.actorId, clinicId: enc.clinicId },
        },
        cVersion,
        tx,
      );
      const eVersion = await this.events.currentVersion(
        'Encounter',
        enc.id,
        tx,
      );
      await this.events.append(
        {
          streamType: 'Encounter',
          streamId: enc.id,
          type: DomainEventType.DoctorOverrideCompleted,
          payload: { reason: enc.overrideReason },
          metadata: { actorId: opts.actorId, clinicId: enc.clinicId },
        },
        eVersion,
        tx,
      );
      return updated;
    });
  }
}
