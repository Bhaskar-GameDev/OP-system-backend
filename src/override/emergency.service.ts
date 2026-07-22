import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Consultation,
  ConsultationState,
  Encounter,
  RegistrationReason,
  RegistrationSource,
} from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { EventStoreService } from '../event-store/event-store.service';
import { DomainEventType } from '../event-store/domain-event.types';
import { StateMachineService } from '../state-machine/state-machine.service';
import { EncounterService } from '../encounters/encounter.service';
import { OpSessionService } from '../queue/op-session.service';

export interface EmergencyInput {
  doctorId: string;
  patientId?: string;
  mobile?: string;
  name?: string;
  serviceDate: string;
  actorId?: string;
}

export interface EmergencyStartResult {
  emergencyEncounter: Encounter;
  emergencyConsultation: Consultation;
  pausedConsultationId: string;
}

/**
 * Emergency handling (ARCHITECTURE.md §8, Phase 9).
 *
 * An emergency is NOT inserted into the token queue — it INTERRUPTS the room:
 *   current consultation --pause--> emergency consultation --end--> resume prior.
 * The waiting queue is never touched; no token loses its place. Belongs to the
 * consultation state machine, not the queue engine.
 */
@Injectable()
export class EmergencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventStoreService,
    private readonly sm: StateMachineService,
    private readonly encounters: EncounterService,
    private readonly sessions: OpSessionService,
  ) {}

  /** Pause the doctor's active consultation and start an emergency in its place. */
  async start(input: EmergencyInput): Promise<EmergencyStartResult> {
    const paused = await this.prisma.consultation.findFirst({
      where: { doctorId: input.doctorId, state: ConsultationState.ACTIVE },
    });
    if (!paused) {
      throw new BadRequestException(
        'no active consultation to interrupt for this doctor',
      );
    }
    const pausedEnc = await this.prisma.encounter.findUnique({
      where: { id: paused.encounterId },
    });
    if (!pausedEnc) throw new NotFoundException('interrupted encounter missing');

    // The emergency patient's encounter (queue-bypass, like an override).
    const emEnc = await this.encounters.register({
      patientId: input.patientId,
      mobile: input.mobile,
      name: input.name,
      doctorId: input.doctorId,
      serviceDate: input.serviceDate,
      source: RegistrationSource.RECEPTION,
      reason: RegistrationReason.NEW,
      actorId: input.actorId,
      channelMeta: { emergency: true },
    });

    const emEncNext = this.sm.nextEncounter(emEnc.status, 'OVERRIDE_CONSULT');
    const pausedConsultNext = this.sm.nextConsultation(paused.state, 'PAUSE');
    const pausedEncNext = this.sm.nextEncounter(pausedEnc.status, 'PAUSE');
    const session = await this.sessions.getOrCreate(
      input.doctorId,
      emEnc.clinicId,
      input.serviceDate,
    );

    return this.prisma.$transaction(async (tx) => {
      // 1) Pause the current consultation + its encounter.
      const pcVersion = await this.events.currentVersion(
        'Consultation',
        paused.id,
        tx,
      );
      await tx.consultation.update({
        where: { id: paused.id },
        data: { state: pausedConsultNext, pausedAt: new Date() },
      });
      await tx.encounter.update({
        where: { id: pausedEnc.id },
        data: { status: pausedEncNext },
      });
      await this.events.append(
        {
          streamType: 'Consultation',
          streamId: paused.id,
          type: DomainEventType.ConsultationPaused,
          payload: { reason: 'emergency' },
          metadata: { actorId: input.actorId, clinicId: pausedEnc.clinicId },
        },
        pcVersion,
        tx,
      );

      // 2) Emergency encounter -> IN_CONSULTATION; open emergency consultation.
      await tx.encounter.update({
        where: { id: emEnc.id },
        data: { status: emEncNext },
      });
      const emConsult = await tx.consultation.create({
        data: {
          encounterId: emEnc.id,
          doctorId: input.doctorId,
          state: ConsultationState.ACTIVE,
          startedAt: new Date(),
          isEmergency: true,
        },
      });
      // 3) Link the paused consultation to the emergency that interrupted it.
      await tx.consultation.update({
        where: { id: paused.id },
        data: { interruptedByConsultationId: emConsult.id },
      });
      await tx.opSession.update({
        where: { id: session.id },
        data: { activeConsultationId: emConsult.id },
      });
      const emEncVersion = await this.events.currentVersion(
        'Encounter',
        emEnc.id,
        tx,
      );
      await this.events.append(
        {
          streamType: 'Encounter',
          streamId: emEnc.id,
          type: DomainEventType.EmergencyStarted,
          payload: { doctorId: input.doctorId, interrupted: pausedEnc.id },
          metadata: { actorId: input.actorId, clinicId: emEnc.clinicId },
        },
        emEncVersion,
        tx,
      );
      await this.events.append(
        {
          streamType: 'Consultation',
          streamId: emConsult.id,
          type: DomainEventType.ConsultationStarted,
          payload: { encounterId: emEnc.id, emergency: true },
          metadata: { actorId: input.actorId, clinicId: emEnc.clinicId },
        },
        0,
        tx,
      );
      return {
        emergencyEncounter: { ...emEnc, status: emEncNext },
        emergencyConsultation: emConsult,
        pausedConsultationId: paused.id,
      };
    });
  }

  /** End the emergency and AUTO-RESUME the interrupted consultation. */
  async end(
    emergencyConsultationId: string,
    opts: { actorId?: string } = {},
  ): Promise<{ resumedConsultationId: string }> {
    const em = await this.prisma.consultation.findUnique({
      where: { id: emergencyConsultationId },
    });
    if (!em || !em.isEmergency) {
      throw new NotFoundException('emergency consultation not found');
    }
    if (em.state !== ConsultationState.ACTIVE) {
      throw new BadRequestException('emergency consultation is not active');
    }
    const emEnc = await this.prisma.encounter.findUnique({
      where: { id: em.encounterId },
    });
    const paused = await this.prisma.consultation.findFirst({
      where: { interruptedByConsultationId: em.id },
    });
    if (!paused) throw new NotFoundException('paused consultation missing');
    const pausedEnc = await this.prisma.encounter.findUnique({
      where: { id: paused.encounterId },
    });
    if (!emEnc || !pausedEnc) throw new NotFoundException('encounter missing');

    const emConsultNext = this.sm.nextConsultation(em.state, 'COMPLETE');
    const emEncNext = this.sm.nextEncounter(emEnc.status, 'COMPLETE');
    const resumeConsultNext = this.sm.nextConsultation(paused.state, 'RESUME');
    const resumeEncNext = this.sm.nextEncounter(pausedEnc.status, 'RESUME');
    const session = await this.sessions.getOrCreate(
      em.doctorId,
      emEnc.clinicId,
      emEnc.serviceDate.toISOString().slice(0, 10),
    );

    return this.prisma.$transaction(async (tx) => {
      // Complete the emergency.
      const emVersion = await this.events.currentVersion(
        'Consultation',
        em.id,
        tx,
      );
      await tx.consultation.update({
        where: { id: em.id },
        data: { state: emConsultNext, endedAt: new Date() },
      });
      await tx.encounter.update({
        where: { id: emEnc.id },
        data: { status: emEncNext },
      });
      await this.events.append(
        {
          streamType: 'Consultation',
          streamId: em.id,
          type: DomainEventType.ConsultationCompleted,
          payload: { emergency: true },
          metadata: { actorId: opts.actorId, clinicId: emEnc.clinicId },
        },
        emVersion,
        tx,
      );
      const emEncVersion = await this.events.currentVersion(
        'Encounter',
        emEnc.id,
        tx,
      );
      await this.events.append(
        {
          streamType: 'Encounter',
          streamId: emEnc.id,
          type: DomainEventType.EmergencyEnded,
          payload: { resumed: pausedEnc.id },
          metadata: { actorId: opts.actorId, clinicId: emEnc.clinicId },
        },
        emEncVersion,
        tx,
      );

      // Resume the interrupted consultation.
      const pVersion = await this.events.currentVersion(
        'Consultation',
        paused.id,
        tx,
      );
      await tx.consultation.update({
        where: { id: paused.id },
        data: {
          state: resumeConsultNext,
          resumedAt: new Date(),
          interruptedByConsultationId: null,
        },
      });
      await tx.encounter.update({
        where: { id: pausedEnc.id },
        data: { status: resumeEncNext },
      });
      await tx.opSession.update({
        where: { id: session.id },
        data: { activeConsultationId: paused.id },
      });
      await this.events.append(
        {
          streamType: 'Consultation',
          streamId: paused.id,
          type: DomainEventType.ConsultationResumed,
          payload: { afterEmergency: em.id },
          metadata: { actorId: opts.actorId, clinicId: pausedEnc.clinicId },
        },
        pVersion,
        tx,
      );
      return { resumedConsultationId: paused.id };
    });
  }
}
