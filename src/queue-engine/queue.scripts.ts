/**
 * The atomic Redis scripts behind the queue.
 *
 * Every queue mutation has to be indivisible: two receptionists calling "next"
 * at the same instant must not both get the same patient, and a token must
 * never exist without a place in the line. That is why each of these is a
 * single Lua body — Redis runs it start to finish with nothing interleaved.
 *
 * They were inline in `queue.service.ts`, which made that file 659 lines of two
 * different things: roughly 190 lines of Lua, and the TypeScript that runs it.
 * The scripts are unchanged — only their address is.
 */

/**
 * Lua: issue token + assign shared arrival score + place in the ordered set —
 * all in one atomic server-side step. Guarantees:
 *  - token number is collision-free (per-prefix INCR)
 *  - arrival score is a SINGLE shared monotonic sequence per doctor/session,
 *    so A and W tokens interleave by true arrival, not per-prefix order
 *  - no window where a token exists but isn't placed (or vice-versa)
 *
 * KEYS[1] token counter (A or W)   KEYS[2] shared arrival seq   KEYS[3] queue zset
 * ARGV[1] prefix ("A"/"W")         ARGV[2] zero-pad width
 * ARGV[4] counter baseline ('' = none) — see BASELINE_LUA note below
 * returns { tokenSeq, arrivalScore, tokenNumber }
 */
export const ENQUEUE_LUA = `
if ARGV[4] ~= '' and redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('SET', KEYS[1], ARGV[4])
end
local tokenSeq = redis.call('INCR', KEYS[1])
local score = redis.call('INCR', KEYS[2])
local token = ARGV[1] .. string.format('%0' .. ARGV[2] .. 'd', tokenSeq)
-- ARGV[5] = externally minted display token (OP cutover). The counter is still
-- INCR'd above so the legacy sequence stays dense and tokenBaselineFor keeps
-- working if a later enqueue mints its own number.
if ARGV[5] ~= '' then token = ARGV[5] end
redis.call('ZADD', KEYS[3], score, token)
if ARGV[3] ~= '' then redis.call('HSET', KEYS[4], token, ARGV[3]) end
local card = redis.call('ZCARD', KEYS[3])
return { tokenSeq, score, token, card }
`;

/**
 * Why the counter needs a baseline.
 *
 * Token numbers are issued by a Redis INCR, but the uniqueness they must
 * satisfy is a Postgres index: (doctor_id, session_date, session_type,
 * token_number). Redis is volatile — a restart without persistence, a
 * `docker compose down -v`, or a seeded database paired with a fresh Redis all
 * leave the counter at 0 while Postgres already holds A001..A00n for that
 * session. The next INCR then re-issues a token that already exists and the
 * booking write dies on a unique-constraint violation (surfacing to the patient
 * as "payment verification failed").
 *
 * The caller passes the session's DB high-water mark; the script adopts it only
 * when the counter is absent. Doing it inside the script (rather than an
 * EXISTS/SET round-trip in application code) keeps the seed-then-INCR atomic, so
 * two concurrent cold-start callers can never both take the same number.
 */

/**
 * Atomic DONE: check-and-pop the front of the queue.
 *
 * Guards concurrency: two DONE presses for the same session can't both pop the
 * same patient (so nobody is skipped), and a press for a stale token is
 * rejected instead of advancing the wrong person.
 *
 * KEYS[1] queue zset                ARGV[1] expectedToken ('' = no check)
 * returns {'EMPTY'} | {'MISMATCH', actualFront} | {'OK', doneToken, newFront(''|token)}
 */
export const DONE_LUA = `
local front = redis.call('ZRANGE', KEYS[1], 0, 0)
if #front == 0 then return { 'EMPTY' } end
if ARGV[1] ~= '' and front[1] ~= ARGV[1] then return { 'MISMATCH', front[1] } end
redis.call('ZPOPMIN', KEYS[1])
local nf = redis.call('ZRANGE', KEYS[1], 0, 0)
local newFront = ''
if #nf > 0 then newFront = nf[1] end
return { 'OK', front[1], newFront }
`;

/**
 * Atomic no-show removal of a SPECIFIC token. Decides ACTIVE vs BOOKED vs GONE
 * by the token's current rank, then removes it — in one step so the decision
 * and removal can't drift.
 *
 * KEYS[1] queue zset        ARGV[1] target token
 * returns {'GONE'} | {'ACTIVE', newFront(''|token)} | {'BOOKED'}
 */
export const NOSHOW_LUA = `
local rank = redis.call('ZRANK', KEYS[1], ARGV[1])
if rank == false then return { 'GONE' } end
redis.call('ZREM', KEYS[1], ARGV[1])
if rank == 0 then
  local nf = redis.call('ZRANGE', KEYS[1], 0, 0)
  local newFront = ''
  if #nf > 0 then newFront = nf[1] end
  return { 'ACTIVE', newFront }
end
return { 'BOOKED' }
`;

/**
 * Atomic SKIP: move a specific token to the BACK of the queue. New score is the
 * next value of the shared arrival sequence (always greater than every existing
 * score, fractional priority scores included), so the skipped patient lands
 * last. If it was rank 0, the new front is returned so the caller promotes it.
 *
 * KEYS[1] queue   KEYS[2] arrival seq   ARGV[1] target
 * returns {'GONE'} | {'ACTIVE', newFront} | {'BOOKED'}
 */
export const SKIP_LUA = `
local rank = redis.call('ZRANK', KEYS[1], ARGV[1])
if rank == false then return { 'GONE' } end
local newScore = redis.call('INCR', KEYS[2])
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[1], newScore, ARGV[1])
if rank == 0 then
  local nf = redis.call('ZRANGE', KEYS[1], 0, 0)
  return { 'ACTIVE', nf[1] }
end
return { 'BOOKED' }
`;

/**
 * Atomic EMERGENCY-PRIORITY insert: issue a token, then place it just behind the
 * active patient. Score = midpoint(activeScore, firstWaitingScore). Because a
 * previously-prioritized patient is now the first-waiting one, a fresh priority
 * insert lands ahead of it. Empty queue -> normal arrival score + isFront=1.
 *
 * KEYS[1] tokenCounter  KEYS[2] arrival  KEYS[3] queue  KEYS[4] tokenmap
 * ARGV[1] prefix  ARGV[2] pad  ARGV[3] bookingId
 * returns { token, scoreStr, isFront }
 */
export const PRIORITY_LUA = `
local card = redis.call('ZCARD', KEYS[3])
local score
local isFront = 0
if card == 0 then
  score = redis.call('INCR', KEYS[2])
  isFront = 1
else
  local top = redis.call('ZRANGE', KEYS[3], 0, 1, 'WITHSCORES')
  local activeScore = tonumber(top[2])
  local upper
  if #top >= 4 then upper = tonumber(top[4]) else upper = activeScore + 1 end
  score = (activeScore + upper) / 2
  -- float-precision guard: midpoint must sit strictly between the bounds
  if score <= activeScore or score >= upper then return { 'PRECISION' } end
end
-- token only issued AFTER the guard passes (no wasted token number on reject)
if ARGV[4] ~= '' and redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('SET', KEYS[1], ARGV[4])
end
local tokenSeq = redis.call('INCR', KEYS[1])
local token = ARGV[1] .. string.format('%0' .. ARGV[2] .. 'd', tokenSeq)
redis.call('ZADD', KEYS[3], score, token)
if ARGV[3] ~= '' then redis.call('HSET', KEYS[4], token, ARGV[3]) end
return { 'OK', token, tostring(score), isFront }
`;

/**
 * Atomic PRIORITY MOVE of a token that is ALREADY in the queue: re-score it to
 * midpoint(activeScore, firstWaitingScore) so it becomes the first waiter,
 * KEEPING its existing number. ZADD on an existing member updates the score in
 * place, so the patient is never duplicated and never renumbered.
 *
 * Used when reception prioritises someone who is already queued; a booking with
 * no live token still goes through PRIORITY_LUA (fresh token minted).
 *
 * KEYS[1] queue   ARGV[1] token
 * returns {'GONE'} | {'FRONT', scoreStr} | {'PRECISION'} | {'OK', scoreStr}
 */
export const PRIORITY_MOVE_LUA = `
local cur = redis.call('ZSCORE', KEYS[1], ARGV[1])
if cur == false then return { 'GONE' } end
local top = redis.call('ZRANGE', KEYS[1], 0, 1, 'WITHSCORES')
-- rank 0: the active patient, already ahead of everyone
if top[1] == ARGV[1] then return { 'FRONT', cur } end
-- rank 1: already the first waiter, nothing to gain from re-scoring
if #top >= 3 and top[3] == ARGV[1] then return { 'OK', cur } end
local activeScore = tonumber(top[2])
local upper = tonumber(top[4])
local score = (activeScore + upper) / 2
if score <= activeScore or score >= upper then return { 'PRECISION' } end
redis.call('ZADD', KEYS[1], score, ARGV[1])
return { 'OK', tostring(score) }
`;

/**
 * Atomic REINSERT after an existing in-queue token. Score = midpoint(anchorScore,
 * nextMemberScore). Rejects if the token is already present, or the anchor is
 * gone by the time it runs.
 *
 * KEYS[1] queue   KEYS[2] tokenmap
 * ARGV[1] token   ARGV[2] afterToken   ARGV[3] bookingId
 * returns {'PRESENT'} | {'GONE'} | {'OK', scoreStr}
 */
export const REINSERT_LUA = `
if redis.call('ZRANK', KEYS[1], ARGV[1]) ~= false then return { 'PRESENT' } end
local afterRank = redis.call('ZRANK', KEYS[1], ARGV[2])
if afterRank == false then return { 'GONE' } end
local lower = tonumber(redis.call('ZSCORE', KEYS[1], ARGV[2]))
local nextm = redis.call('ZRANGE', KEYS[1], afterRank + 1, afterRank + 1, 'WITHSCORES')
local upper
if #nextm >= 2 then upper = tonumber(nextm[2]) else upper = lower + 1 end
local score = (lower + upper) / 2
if score <= lower or score >= upper then return { 'PRECISION' } end
redis.call('ZADD', KEYS[1], score, ARGV[1])
if ARGV[3] ~= '' then redis.call('HSET', KEYS[2], ARGV[1], ARGV[3]) end
return { 'OK', tostring(score) }
`;
