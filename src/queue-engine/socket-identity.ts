import type { Socket } from 'socket.io';

/**
 * Who a socket claims to be, read from its handshake.
 *
 * Extracted from `queue.gateway.ts`: this is the untrusted edge of the realtime
 * layer, and it reads better beside its own comment than buried under 600 lines
 * of room management. Unchanged otherwise.
 */
export function extractDisplayClinic(client: Socket): string | null {
  const auth = client.handshake.auth as
    | { display?: unknown; clinicId?: unknown }
    | undefined;
  if (auth?.display === true && typeof auth.clinicId === 'string') {
    return auth.clinicId;
  }
  const q = client.handshake.query ?? {};
  if (q.display === 'true' && typeof q.clinicId === 'string') {
    return q.clinicId;
  }
  return null;
}

/**
 * Session token from the handshake — `auth` payload or Authorization header.
 *
 * The query-string fallback was removed deliberately. A credential in a query
 * string is written to proxy access logs, browser history and referrer headers,
 * which are not places designed to hold one, and every client here already
 * sends the token in the handshake `auth` payload.
 */
export function extractToken(client: Socket): string {
  const auth = client.handshake.auth as { token?: string } | undefined;
  if (auth?.token) return auth.token;
  const header = client.handshake.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  throw new Error('no token');
}
