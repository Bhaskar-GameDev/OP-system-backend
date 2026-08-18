/**
 * The per-session mutex behind every consultation transition.
 *
 * Two receptionists pressing "next" at the same moment must not both advance the
 * queue, so each transition takes a short Redis lock keyed by session. The
 * release is a compare-and-delete script rather than a plain DEL: a plain delete
 * can drop a lock that a LATER holder acquired after this one expired, which
 * turns a slow request into a silently corrupted queue.
 *
 * Extracted from `consultation.service.ts`. Values and script are unchanged.
 */

/** How long a held lock survives if the holder dies mid-transition. */
export const LOCK_TTL_MS = 5000;
/** Gap between acquisition attempts. */
export const LOCK_RETRY_MS = 15;
/** How long a caller waits for the lock before giving up. */
export const LOCK_WAIT_MS = 5000;

/** Release lock only if we still own it (compare-and-delete). */
export const UNLOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;
