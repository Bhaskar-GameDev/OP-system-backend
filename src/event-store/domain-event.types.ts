/**
 * Domain event catalogue for the token-based OPD engine (ARCHITECTURE.md §12.1).
 *
 * The event log is the source of truth: aggregate state is a fold over these
 * events, read models (CQRS, §12.2) are projections, and the audit trail is a
 * natural by-product (§12.5). Event names are STABLE — renaming one breaks
 * replay, so add new names rather than repurpose old ones.
 */

/** Aggregate stream a domain event belongs to. */
export type StreamType =
  | 'Encounter'
  | 'Consultation'
  | 'OpSession'
  | 'OpPayment'
  | 'Config';

/** Every domain event type emitted by the engine. */
export const DomainEventType = {
  // Encounter lifecycle
  EncounterCreated: 'EncounterCreated',
  PatientArrived: 'PatientArrived',
  PatientCheckedIn: 'PatientCheckedIn',
  TokenIssued: 'TokenIssued',
  QueueEntered: 'QueueEntered',
  PatientCalled: 'PatientCalled',
  PatientSkipped: 'PatientSkipped',
  PatientRecalled: 'PatientRecalled',
  NoShowMarked: 'NoShowMarked',
  EncounterTransferred: 'EncounterTransferred',
  EncounterCancelled: 'EncounterCancelled',
  // Consultation lifecycle
  ConsultationStarted: 'ConsultationStarted',
  ConsultationPaused: 'ConsultationPaused',
  ConsultationResumed: 'ConsultationResumed',
  ConsultationCompleted: 'ConsultationCompleted',
  // Doctor Override (§7)
  DoctorOverrideStarted: 'DoctorOverrideStarted',
  DoctorOverrideCompleted: 'DoctorOverrideCompleted',
  // Emergency interruption (§8)
  EmergencyStarted: 'EmergencyStarted',
  EmergencyEnded: 'EmergencyEnded',
  // Session
  OpSessionOpened: 'OpSessionOpened',
  OpSessionPaused: 'OpSessionPaused',
  OpSessionResumed: 'OpSessionResumed',
  OpSessionClosed: 'OpSessionClosed',
  // Payment (decoupled, §3.2)
  PaymentSettled: 'PaymentSettled',
  // Config (§10)
  ConfigChanged: 'ConfigChanged',
} as const;

export type DomainEventType =
  (typeof DomainEventType)[keyof typeof DomainEventType];

/** Metadata carried on every event — the audit context (who/where/why). */
export interface EventMetadata {
  actorId?: string;
  actorRole?: string; // DOCTOR | STAFF | ADMIN | SYSTEM | PATIENT
  clinicId?: string;
  source?: string; // registration source, for analytics only
  correlationId?: string; // ties a chain of events to one request/command
  [k: string]: unknown;
}

/** A domain event to append (version is assigned by the store). */
export interface EventInput {
  streamType: StreamType;
  streamId: string;
  type: DomainEventType;
  payload: Record<string, unknown>;
  metadata?: EventMetadata;
}

/** A persisted domain event as read back from the store. */
export interface StoredEvent {
  id: string;
  streamType: StreamType;
  streamId: string;
  version: number;
  type: DomainEventType;
  payload: Record<string, unknown>;
  metadata: EventMetadata | null;
  occurredAt: Date;
  globalSeq: bigint;
}
