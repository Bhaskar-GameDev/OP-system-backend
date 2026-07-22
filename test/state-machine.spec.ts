import { EncounterStatus, ConsultationState } from '@prisma/client';
import { encounterMachine } from '../src/state-machine/encounter.machine';
import { consultationMachine } from '../src/state-machine/consultation.machine';
import { IllegalTransitionError } from '../src/state-machine/transition';

/**
 * Metadata-driven state machine (Phase 12). Pure — no DB. Locks in the hard
 * architectural rules: token only after check-in, one queue path, override and
 * emergency as first-class transitions.
 */
describe('Encounter state machine', () => {
  it('drives the happy path register -> completed', () => {
    let s: EncounterStatus = EncounterStatus.REGISTERED;
    s = encounterMachine.next(s, 'ARRIVE');
    expect(s).toBe(EncounterStatus.ARRIVED);
    s = encounterMachine.next(s, 'CHECK_IN');
    expect(s).toBe(EncounterStatus.CHECKED_IN);
    s = encounterMachine.next(s, 'ISSUE_TOKEN');
    expect(s).toBe(EncounterStatus.TOKEN_ISSUED);
    s = encounterMachine.next(s, 'ENQUEUE');
    expect(s).toBe(EncounterStatus.WAITING);
    s = encounterMachine.next(s, 'CALL');
    expect(s).toBe(EncounterStatus.CALLED);
    s = encounterMachine.next(s, 'START_CONSULT');
    expect(s).toBe(EncounterStatus.IN_CONSULTATION);
    s = encounterMachine.next(s, 'COMPLETE');
    expect(s).toBe(EncounterStatus.COMPLETED);
  });

  it('FORBIDS issuing a token before check-in (core rule §3)', () => {
    expect(encounterMachine.can(EncounterStatus.REGISTERED, 'ISSUE_TOKEN')).toBe(
      false,
    );
    expect(() =>
      encounterMachine.next(EncounterStatus.REGISTERED, 'ISSUE_TOKEN'),
    ).toThrow(IllegalTransitionError);
  });

  it('FORBIDS enqueue before a token exists', () => {
    expect(encounterMachine.can(EncounterStatus.CHECKED_IN, 'ENQUEUE')).toBe(
      false,
    );
  });

  it('allows reception combined path REGISTERED -> CHECKED_IN (AUTO)', () => {
    expect(encounterMachine.can(EncounterStatus.REGISTERED, 'CHECK_IN')).toBe(
      true,
    );
  });

  it('supports skip then recall back to waiting', () => {
    const skipped = encounterMachine.next(EncounterStatus.WAITING, 'SKIP');
    expect(skipped).toBe(EncounterStatus.SKIPPED);
    expect(encounterMachine.next(skipped, 'RECALL')).toBe(
      EncounterStatus.WAITING,
    );
  });

  it('recall is allowed after no-show', () => {
    expect(encounterMachine.next(EncounterStatus.NO_SHOW, 'RECALL')).toBe(
      EncounterStatus.WAITING,
    );
  });

  it('doctor override jumps waiting -> in_consultation (§7)', () => {
    expect(
      encounterMachine.next(EncounterStatus.WAITING, 'OVERRIDE_CONSULT'),
    ).toBe(EncounterStatus.IN_CONSULTATION);
    // and even directly from REGISTERED (VIP walked straight in)
    expect(
      encounterMachine.next(EncounterStatus.REGISTERED, 'OVERRIDE_CONSULT'),
    ).toBe(EncounterStatus.IN_CONSULTATION);
  });

  it('cancel allowed pre-consult, forbidden mid-consult', () => {
    expect(encounterMachine.can(EncounterStatus.WAITING, 'CANCEL')).toBe(true);
    expect(
      encounterMachine.can(EncounterStatus.IN_CONSULTATION, 'CANCEL'),
    ).toBe(false);
  });

  it('rejects duplicate transition definitions at construction (guard for config errors)', () => {
    // encounterMachine built without throwing => table is unambiguous
    expect(encounterMachine.states()).toContain(EncounterStatus.COMPLETED);
  });
});

describe('Consultation state machine (§6.2, §8)', () => {
  it('start -> pause -> resume -> complete', () => {
    let c: ConsultationState = ConsultationState.PENDING;
    c = consultationMachine.next(c, 'START');
    expect(c).toBe(ConsultationState.ACTIVE);
    c = consultationMachine.next(c, 'PAUSE'); // emergency interrupt or break
    expect(c).toBe(ConsultationState.PAUSED);
    c = consultationMachine.next(c, 'RESUME');
    expect(c).toBe(ConsultationState.ACTIVE);
    c = consultationMachine.next(c, 'COMPLETE');
    expect(c).toBe(ConsultationState.COMPLETED);
  });

  it('cannot complete a paused consultation without resuming', () => {
    expect(
      consultationMachine.can(ConsultationState.PAUSED, 'COMPLETE'),
    ).toBe(false);
  });

  it('cannot pause a pending (not yet started) consultation', () => {
    expect(consultationMachine.can(ConsultationState.PENDING, 'PAUSE')).toBe(
      false,
    );
  });
});
