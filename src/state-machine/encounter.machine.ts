import { EncounterStatus } from '@prisma/client';
import { StateMachine, Transition } from './transition';

/**
 * Encounter lifecycle (ARCHITECTURE.md §6.1). Events are the verbs a command
 * issues; the machine decides whether the verb is legal in the current state.
 */
export type EncounterEvent =
  | 'ARRIVE'
  | 'CHECK_IN'
  | 'ISSUE_TOKEN'
  | 'ENQUEUE'
  | 'CALL'
  | 'START_CONSULT'
  | 'SKIP'
  | 'RECALL'
  | 'MARK_NO_SHOW'
  | 'COMPLETE'
  | 'TRANSFER'
  | 'CANCEL'
  | 'OVERRIDE_CONSULT'
  | 'PAUSE'
  | 'RESUME';

const S = EncounterStatus;

/**
 * Transition table. Note the hard rule baked in as structure:
 *  - No ISSUE_TOKEN before CHECK_IN (token is gated on physical presence, §3).
 *  - No ENQUEUE before a token exists.
 *  - CANCEL is allowed from any pre-consultation state.
 *  - OVERRIDE_CONSULT (§7) jumps a waiting/registered encounter straight into
 *    consultation WITHOUT renumbering the queue — modelled as its own event.
 */
const TRANSITIONS: Transition<EncounterStatus, EncounterEvent>[] = [
  { from: S.REGISTERED, event: 'ARRIVE', to: S.ARRIVED },
  // Reception combined path may check in directly from REGISTERED (method AUTO).
  { from: S.REGISTERED, event: 'CHECK_IN', to: S.CHECKED_IN },
  { from: S.ARRIVED, event: 'CHECK_IN', to: S.CHECKED_IN },
  { from: S.CHECKED_IN, event: 'ISSUE_TOKEN', to: S.TOKEN_ISSUED },
  { from: S.TOKEN_ISSUED, event: 'ENQUEUE', to: S.WAITING },
  { from: S.WAITING, event: 'CALL', to: S.CALLED },
  { from: S.CALLED, event: 'START_CONSULT', to: S.IN_CONSULTATION },
  { from: S.CALLED, event: 'MARK_NO_SHOW', to: S.NO_SHOW },
  // Emergency interruption (§8): the interrupted encounter pauses and resumes.
  { from: S.IN_CONSULTATION, event: 'PAUSE', to: S.PAUSED },
  { from: S.PAUSED, event: 'RESUME', to: S.IN_CONSULTATION },
  { from: S.PAUSED, event: 'COMPLETE', to: S.COMPLETED },
  { from: S.WAITING, event: 'SKIP', to: S.SKIPPED },
  { from: S.CALLED, event: 'SKIP', to: S.SKIPPED },
  { from: S.SKIPPED, event: 'RECALL', to: S.WAITING },
  { from: S.NO_SHOW, event: 'RECALL', to: S.WAITING },
  { from: S.IN_CONSULTATION, event: 'COMPLETE', to: S.COMPLETED },
  // Transfer to another doctor: allowed while waiting or already called.
  { from: S.WAITING, event: 'TRANSFER', to: S.TRANSFERRED },
  { from: S.CALLED, event: 'TRANSFER', to: S.TRANSFERRED },
  { from: S.SKIPPED, event: 'TRANSFER', to: S.TRANSFERRED },
  // Doctor Override — first-class jump into consultation (§7).
  { from: S.REGISTERED, event: 'OVERRIDE_CONSULT', to: S.IN_CONSULTATION },
  { from: S.CHECKED_IN, event: 'OVERRIDE_CONSULT', to: S.IN_CONSULTATION },
  { from: S.TOKEN_ISSUED, event: 'OVERRIDE_CONSULT', to: S.IN_CONSULTATION },
  { from: S.WAITING, event: 'OVERRIDE_CONSULT', to: S.IN_CONSULTATION },
  { from: S.CALLED, event: 'OVERRIDE_CONSULT', to: S.IN_CONSULTATION },
  // Cancellation from any pre-consultation state.
  { from: S.REGISTERED, event: 'CANCEL', to: S.CANCELLED },
  { from: S.ARRIVED, event: 'CANCEL', to: S.CANCELLED },
  { from: S.CHECKED_IN, event: 'CANCEL', to: S.CANCELLED },
  { from: S.TOKEN_ISSUED, event: 'CANCEL', to: S.CANCELLED },
  { from: S.WAITING, event: 'CANCEL', to: S.CANCELLED },
  { from: S.SKIPPED, event: 'CANCEL', to: S.CANCELLED },
];

export const encounterMachine = new StateMachine<
  EncounterStatus,
  EncounterEvent
>('Encounter', TRANSITIONS);
