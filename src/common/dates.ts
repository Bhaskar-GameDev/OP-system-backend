/**
 * Calendar-day formatting.
 *
 * Two functions, and the difference between them is load-bearing — this is why
 * they now live together rather than as six private copies scattered across
 * reports, discovery, display, voice and session resolution:
 *
 *  - {@link ymd} reads the UTC day. Correct for a `@db.Date` column, which
 *    Prisma returns as a UTC-midnight Date: formatting that in local time can
 *    shift it a day either side of midnight.
 *  - {@link ymdLocal} reads the operator's day. Correct for "today" as a human
 *    at the desk means it, and for bounding a full timestamp such as createdAt.
 *
 * They are NOT interchangeable, and neither is a "fixed" version of the other.
 * Pick by what the value is, not by which one is nearer.
 */

/** Calendar day of a UTC instant, `YYYY-MM-DD`. Use for `@db.Date` values. */
export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Calendar day in the server's local zone, `YYYY-MM-DD`. */
export function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Today in the server's local zone, `YYYY-MM-DD`. */
export function todayYmdLocal(): string {
  return ymdLocal(new Date());
}
