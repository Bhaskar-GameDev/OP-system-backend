import { ConsultationState } from '@prisma/client';
import { StateMachine, Transition } from './transition';

/**
 * Consultation (in-room) lifecycle (ARCHITECTURE.md §6.2, §8).
 *
 * PAUSE/RESUME cover both a plain break and an emergency interruption — the
 * emergency's own consultation is a SEPARATE Consultation stream that links back
 * via interruptedByConsultationId; when it ends, the paused one RESUMEs.
 * Invariant enforced by callers: at most one ACTIVE consultation per doctor.
 */
export type ConsultationEvent =
  | 'START'
  | 'PAUSE'
  | 'RESUME'
  | 'COMPLETE'
  | 'TRANSFER';

const S = ConsultationState;

const TRANSITIONS: Transition<ConsultationState, ConsultationEvent>[] = [
  { from: S.PENDING, event: 'START', to: S.ACTIVE },
  { from: S.ACTIVE, event: 'PAUSE', to: S.PAUSED },
  { from: S.PAUSED, event: 'RESUME', to: S.ACTIVE },
  { from: S.ACTIVE, event: 'COMPLETE', to: S.COMPLETED },
  { from: S.ACTIVE, event: 'TRANSFER', to: S.TRANSFERRED },
  { from: S.PAUSED, event: 'TRANSFER', to: S.TRANSFERRED },
];

export const consultationMachine = new StateMachine<
  ConsultationState,
  ConsultationEvent
>('Consultation', TRANSITIONS);
