import { BadRequestException, Injectable } from '@nestjs/common';
import { ConsultationState, EncounterStatus } from '@prisma/client';
import { encounterMachine, EncounterEvent } from './encounter.machine';
import {
  consultationMachine,
  ConsultationEvent,
} from './consultation.machine';
import { IllegalTransitionError } from './transition';

/**
 * Single entry point for state-transition validation (Phase 12). Domain services
 * MUST route status changes through here rather than assigning states directly —
 * that keeps every legal path in one declarative table and turns an illegal
 * transition into a clean 400 instead of corrupt state.
 */
@Injectable()
export class StateMachineService {
  // ── Encounter ──────────────────────────────────────────
  canEncounter(from: EncounterStatus, event: EncounterEvent): boolean {
    return encounterMachine.can(from, event);
  }

  /** Resolve the next encounter status or throw 400. */
  nextEncounter(from: EncounterStatus, event: EncounterEvent): EncounterStatus {
    return this.guard(() => encounterMachine.next(from, event));
  }

  encounterEventsFrom(from: EncounterStatus): EncounterEvent[] {
    return encounterMachine.eventsFrom(from);
  }

  // ── Consultation ───────────────────────────────────────
  canConsultation(from: ConsultationState, event: ConsultationEvent): boolean {
    return consultationMachine.can(from, event);
  }

  nextConsultation(
    from: ConsultationState,
    event: ConsultationEvent,
  ): ConsultationState {
    return this.guard(() => consultationMachine.next(from, event));
  }

  consultationEventsFrom(from: ConsultationState): ConsultationEvent[] {
    return consultationMachine.eventsFrom(from);
  }

  private guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof IllegalTransitionError) {
        throw new BadRequestException(e.message);
      }
      throw e;
    }
  }
}
