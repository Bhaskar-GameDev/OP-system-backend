import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  /** Correlates every log line, metric label and error body for one request. */
  requestId: string;
  method?: string;
  url?: string;
}

/**
 * Per-request context, carried implicitly through async work.
 *
 * The backend had no correlation id at all: two concurrent bookings produced
 * interleaved log lines with nothing to tell them apart, so "what else happened
 * during the request that 500'd" was unanswerable. Threading an id through every
 * service signature would touch the whole codebase and be forgotten at the first
 * new call site, so it lives in AsyncLocalStorage instead — set once by the
 * middleware, readable from anywhere, invisible to business logic.
 */
const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with `context` attached to everything it awaits. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The active request id, or undefined outside a request. */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Header carrying the id in and out; matches the common proxy convention. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Accept an inbound request id, or mint one.
 *
 * An inbound value is echoed so a trace started at the edge (Caddy, a client,
 * the voice agent) stays one thread — but it is untrusted input that ends up in
 * log lines, so it is length-capped and restricted to characters that cannot
 * forge a log record or smuggle control bytes. Anything else is replaced rather
 * than sanitised, because a caller sending a malformed id has no expectation
 * worth preserving.
 */
export function resolveRequestId(inbound: unknown): string {
  const value = Array.isArray(inbound) ? inbound[0] : inbound;
  if (typeof value === 'string' && /^[\w.:-]{8,128}$/.test(value)) return value;
  return randomUUID();
}
