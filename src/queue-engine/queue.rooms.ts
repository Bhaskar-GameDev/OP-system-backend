import { SessionKey } from './token.service';

/**
 * Room names for the realtime layer.
 *
 * A room name is a wire contract: the desk apps, the patient app and the
 * display board all join strings built to these shapes, so a stray edit here
 * silently disconnects a surface rather than failing a build. They were inline
 * in `queue.gateway.ts` — 623 lines that mixed the naming scheme, the socket
 * handshake parsing and the gateway's own behaviour. The strings are unchanged.
 */
export const sessionRoom = (s: SessionKey): string =>
  `session:${s.doctorId}:${s.sessionDate}:${s.sessionType}`;
export const bookingRoom = (bookingId: string): string => `booking:${bookingId}`;
export const displayRoom = (clinicId: string): string => `display:${clinicId}`;

// New token-engine realtime rooms (Task 3), additive alongside the legacy rooms
// above so the existing app contract is untouched.
export const OP_SESSION_PREFIX = 'op-session:';
export const OP_ENCOUNTER_PREFIX = 'op-encounter:';
export const opSessionRoom = (opSessionId: string): string =>
  `${OP_SESSION_PREFIX}${opSessionId}`;
export const opEncounterRoom = (encounterId: string): string =>
  `${OP_ENCOUNTER_PREFIX}${encounterId}`;
