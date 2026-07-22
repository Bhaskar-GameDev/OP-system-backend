import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CheckInMethod,
  Consultation,
  ConsultationState,
  Encounter,
  EncounterStatus,
  RegistrationReason,
  RegistrationSource,
} from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { EventStoreService } from '../event-store/event-store.service';
import { DomainEventType } from '../event-store/domain-event.types';
import { StateMachineService } from '../state-machine/state-machine.service';
import { OpQueueService, QueueCandidate } from '../queue/op-queue.service';
import { OpSessionService } from '../queue/op-session.service';
import { QueuePolicyService } from '../queue/queue-policy.service';
import { EncounterService } from '../encounters/encounter.service';
import { CheckInService } from '../check-in/checkin.service';
import { TokenSeriesService } from '../tokens/token-series.service';

export interface CallResult {
  candidate: QueueCandidate;
  encounter: Encounter;
}

/**
 * Consultation engine (ARCHITECTURE.md §6.2, §9, Phase 7).
 *
 * Doctor controls: Call Next, Start, Skip, Recall, No-show, Complete, Pause,
 * Resume, Transfer. Every state change routes through the metadata state machine
 * (legal-only) and is written to the event log (fully audited). Hard invariant:
 * at most ONE ACTIVE consultation per doctor.
 */
@Injectable()
export class ConsultationEngineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventStoreService,
    private readonly sm: StateMachineService,
    private readonly queue: OpQueueService,
    private readonly sessions: OpSessionService,
    private readonly policies: QueuePolicyService,
    private readonly encounters: EncounterService,
    private readonly checkins: CheckInService,
    private readonly tokens: TokenSeriesService,
  ) {}

  /**
   * Call the next patient per policy: pick via the queue engine, remove from the
   * live line (recording it against the RATIO counter), mark CALLED, notify.
   * Returns null when the queue is empty. Does NOT start the consultation.
   */
  async callNext(
    opSessionId: string,
    opts: { category?: string; actorId?: string } = {},
  ): Promise<CallResult | null> {
    const candidate = await this.queue.whoNext(opSessionId, {
      category: opts.category,
    });
    if (!candidate) return null;

    const enc = await this.mustGet(candidate.encounterId);
    const next = this.sm.nextEncounter(enc.status, 'CALL');

    // Remove from the Redis line + advance the served counter (ratio fairness).
    await this.queue.dequeue(
      opSessionId,
      candidate.encounterId,
      candidate.category,
      { recordServed: true },
    );

    const encounter = await this.prisma.$transaction(async (tx) => {
      const version = await this.events.currentVersion('Encounter', enc.id, tx);
      const updated = await tx.encounter.update({
        where: { id: enc.id },
        data: { status: next },
      });
      await this.events.append(
        {
          streamType: 'Encounter',
          streamId: enc.id,
          type: DomainEventType.PatientCalled,
          payload: { opSessionId, category: candidate.category },
          metadata: { actorId: opts.actorId, clinicId: enc.clinicId },
        },
        version,
        tx,
      );
      return updated;
    });

    return { candidate, encounter };
  }

  /**
   * Begin the in-room consultation for a CALLED encounter. Enforces the
   * one-ACTIVE-per-doctor invariant. Opens a Consultation stream (ConsultationStarted).
   */
  async startConsultation(
    encounterId: string,
    opts: { roomId?: string; actorId?: string } = {},
  ): Promise<Consultation> {
    const enc = await this.mustGet(encounterId);
    const nextStatus = this.sm.nextEncounter(enc.status, 'START_CONSULT');

    // One ACTIVE consultation per doctor.
    const active = await this.prisma.consultation.findFirst({
      where: { doctorId: enc.doctorId, state: ConsultationState.ACTIVE },
    });
    if (active) {
      throw new ConflictException(
        'doctor already has an active consultation — complete or pause it first',
      );
    }

    const session = await this.sessions.getOrCreate(
      enc.doctorId,
      enc.clinicId,
      enc.serviceDate.toISOString().slice(0, 10),
    );

    return this.prisma.$transaction(async (tx) => {
      const consult = await tx.consultation.create({
        data: {
          encounterId: enc.id,
          doctorId: enc.doctorId,
          roomId: opts.roomId ?? null,
          state: ConsultationState.ACTIVE,
          startedAt: new Date(),
        },
      });
      await tx.encounter.update({
        where: { id: enc.id },
        data: { status: nextStatus },
      });
      await tx.opSession.update({
        where: { id: session.id },
        data: { activeConsultationId: consult.id },
      });
      await this.events.append(
        {
          streamType: 'Consultation',
          streamId: consult.id,
          type: DomainEventType.ConsultationStarted,
          payload: { encounterId: enc.id, doctorId: enc.doctorId },
          metadata: { actorId: opts.actorId, clinicId: enc.clinicId },
        },
        0,
        tx,
      );
      return consult;
    });
  }

  /** Complete the active consultation. Clears the session's active pointer. */
  async complete(
    encounterId: string,
    opts: { actorId?: string } = {},
  ): Promise<Consultation> {
    const enc = await this.mustGet(encounterId);
    const nextStatus = this.sm.nextEncounter(enc.status, 'COMPLETE');
    const consult = await this.prisma.consultation.findFirst({
      where: { encounterId, state: ConsultationState.ACTIVE },
    });
    if (!consult) throw new BadRequestException('no active consultation');
    const nextConsult = this.sm.nextConsultation(consult.state, 'COMPLETE');

    return this.prisma.$transaction(async (tx) => {
      const version = await this.events.currentVersion(
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
          payload: { encounterId: enc.id },
          metadata: { actorId: opts.actorId, clinicId: enc.clinicId },
        },
        version,
        tx,
      );
      return updated;
    });
  }

  /** Skip a WAITING/CALLED patient: out of the live line (§9). Audited. */
  async skip(
    encounterId: string,
    opts: { actorId?: string } = {},
  ): Promise<Encounter> {
    const enc = await this.mustGet(encounterId);
    const next = this.sm.nextEncounter(enc.status, 'SKIP');
    const category = await this.categoryOf(enc);
    const entry = await this.mustEntry(encounterId);
    await this.queue.dequeue(entry.opSessionId, encounterId, category);
    return this.applyEncounterEvent(
      enc,
      next,
      DomainEventType.PatientSkipped,
      { category },
      opts.actorId,
    );
  }

  /** Recall a SKIPPED/NO_SHOW patient back into the line (front/back per policy). */
  async recall(
    encounterId: string,
    opts: { actorId?: string } = {},
  ): Promise<Encounter> {
    const enc = await this.mustGet(encounterId);
    const next = this.sm.nextEncounter(enc.status, 'RECALL');
    const category = await this.categoryOf(enc);
    const entry = await this.mustEntry(encounterId);
    const policy = await this.policies.resolve(enc.clinicId, enc.doctorId);
    if (policy.skipRules.reinsertPosition === 'front') {
      await this.queue.requeueFront(entry.opSessionId, encounterId, category);
    } else {
      await this.queue.requeue(entry.opSessionId, encounterId, category);
    }
    return this.applyEncounterEvent(
      enc,
      next,
      DomainEventType.PatientRecalled,
      { category },
      opts.actorId,
    );
  }

  /** Mark a CALLED patient as a no-show: removed from the line. */
  async noShow(
    encounterId: string,
    opts: { actorId?: string } = {},
  ): Promise<Encounter> {
    const enc = await this.mustGet(encounterId);
    const next = this.sm.nextEncounter(enc.status, 'MARK_NO_SHOW');
    const category = await this.categoryOf(enc);
    const entry = await this.mustEntry(encounterId);
    await this.queue.dequeue(entry.opSessionId, encounterId, category);
    return this.applyEncounterEvent(
      enc,
      next,
      DomainEventType.NoShowMarked,
      { category },
      opts.actorId,
    );
  }

  /** Doctor pause — stop calling (§9). Delegates to the session. */
  async pauseSession(opSessionId: string) {
    return this.sessions.pause(opSessionId);
  }

  /** Resume calling. */
  async resumeSession(opSessionId: string) {
    return this.sessions.resume(opSessionId);
  }

  /**
   * Transfer an encounter to another doctor: mark the old one TRANSFERRED and
   * removed from its line, then create a fresh encounter under the target doctor,
   * check it in, reissue a token in the target series, and enqueue. The token is
   * reissued because token series belong to the target doctor's clinic (§9).
   */
  async transfer(
    encounterId: string,
    toDoctorId: string,
    opts: { actorId?: string } = {},
  ): Promise<{ old: Encounter; newEncounterId: string }> {
    const enc = await this.mustGet(encounterId);
    const next = this.sm.nextEncounter(enc.status, 'TRANSFER');
    const category = await this.categoryOf(enc);
    const entry = await this.prisma.queueEntry.findUnique({
      where: { encounterId },
    });
    if (entry) {
      await this.queue.dequeue(entry.opSessionId, encounterId, category);
    }

    // New encounter under the target doctor (same patient/date; reason REFERRED).
    const created = await this.encounters.register({
      patientId: enc.patientId,
      doctorId: toDoctorId,
      serviceDate: enc.serviceDate.toISOString().slice(0, 10),
      source: RegistrationSource.RECEPTION,
      reason: RegistrationReason.REFERRED,
      channelMeta: { transferFrom: enc.id },
    });
    await this.checkins.checkIn(created.id, CheckInMethod.AUTO, {
      issueToken: true,
      checkedInBy: opts.actorId,
    });
    await this.queue.enqueue(created.id);

    const old = await this.applyEncounterEvent(
      enc,
      next,
      DomainEventType.EncounterTransferred,
      { toDoctorId, newEncounterId: created.id },
      opts.actorId,
    );
    return { old, newEncounterId: created.id };
  }

  // ── helpers ────────────────────────────────────────────

  private async applyEncounterEvent(
    enc: Encounter,
    nextStatus: EncounterStatus,
    type: DomainEventType,
    payload: Record<string, unknown>,
    actorId?: string,
  ): Promise<Encounter> {
    return this.prisma.$transaction(async (tx) => {
      const version = await this.events.currentVersion('Encounter', enc.id, tx);
      const updated = await tx.encounter.update({
        where: { id: enc.id },
        data: { status: nextStatus },
      });
      await this.events.append(
        {
          streamType: 'Encounter',
          streamId: enc.id,
          type,
          payload,
          metadata: { actorId, clinicId: enc.clinicId },
        },
        version,
        tx,
      );
      return updated;
    });
  }

  private async mustGet(encounterId: string): Promise<Encounter> {
    const enc = await this.prisma.encounter.findUnique({
      where: { id: encounterId },
    });
    if (!enc) throw new NotFoundException('encounter not found');
    return enc;
  }

  private async mustEntry(encounterId: string) {
    const entry = await this.prisma.queueEntry.findUnique({
      where: { encounterId },
    });
    if (!entry) throw new BadRequestException('encounter has no queue entry');
    return entry;
  }

  private async categoryOf(enc: Encounter): Promise<string> {
    const series = await this.prisma.tokenSeries.findUnique({
      where: { id: enc.opCategoryId },
      select: { code: true },
    });
    if (!series) throw new BadRequestException('token series not found');
    return series.code;
  }
}
