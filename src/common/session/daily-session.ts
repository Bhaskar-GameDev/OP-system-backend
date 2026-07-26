import { SessionType } from '@prisma/client';

/**
 * Clinics run ONE continuous consulting session per doctor per day. There is no
 * morning/evening split: a doctor starts at their scheduled time and consults
 * until the queue is done.
 *
 * `SessionType` survives as a **pinned constant**, not a choice. Removing the
 * column outright would mean rewriting two unique indexes
 * (`uq_token_per_session`, `uq_session`), the Redis key format that every queue
 * and token counter is stored under, and the wire shape of four clients — a
 * migration with real downside and no user-visible benefit. Pinning it keeps all
 * of that untouched while making the concept disappear from the product:
 *
 *   - `(doctorId, sessionDate, sessionType)` is effectively `(doctorId,
 *     sessionDate)` — exactly the one-session-per-day rule we now want.
 *   - `(doctorId, sessionDate, sessionType, tokenNumber)` still gives one token
 *     series per doctor per day.
 *
 * The value is MORNING purely because it already exists in the enum and in old
 * rows; read it as "the day's session", never as a time of day. **Never branch
 * on it, never show it to a user, and never offer it as an input** — resolve
 * every session type through this constant so there is one place to change if
 * the column is ever dropped for real.
 *
 * Historical rows may still carry EVENING. That is intentional: they record what
 * actually happened under the old model and must not be rewritten.
 */
export const DAILY_SESSION_TYPE: SessionType = SessionType.MORNING;

/** End-of-day sentinel ("HH:MM"); a day's session runs until the queue clears. */
export const END_OF_DAY = '24:00';
