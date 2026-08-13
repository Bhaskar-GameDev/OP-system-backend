import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/** The only members of a socket.io client this filter touches. */
export interface WsClientLike {
  id?: string;
  emit(event: string, payload: unknown): unknown;
}

/**
 * Last line of defence for every socket message handler.
 *
 * The HTTP side has {@link AllExceptionsFilter}; the gateway had nothing. Each
 * `@SubscribeMessage` handler guarded the failures it expected — a bad token, a
 * missing field — and anything else (a Prisma timeout inside `onJoin`, a
 * TypeError on a malformed payload) became an unhandled rejection: the client
 * that sent the message got NO reply at all and sat waiting on a dashboard that
 * never populated, while the only trace was a stack in the process log with
 * nothing tying it to a socket.
 *
 * What this does instead:
 *  - answers the offending client with the `error` event the clients already
 *    handle (both desk apps and the patient app listen for it), so a failure
 *    surfaces as a visible state rather than silence;
 *  - never puts internals on the wire — a Prisma message names columns, and a
 *    display board is unauthenticated;
 *  - logs the real error with the socket id, at the severity it deserves.
 *
 * Registered on the gateway with `@UseFilters(new WsExceptionsFilter())`.
 */
@Catch()
export class WsExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('WsUnhandledException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ws = host.switchToWs();
    const client = ws.getClient<WsClientLike>();
    const event = ws.getPattern?.() ?? 'unknown';

    const { message, logAs } = resolve(exception);

    if (logAs === 'error') {
      this.logger.error(
        `ws ${event} (socket ${client?.id ?? 'unknown'}) failed: ${describe(exception)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(`ws ${event} (socket ${client?.id ?? 'unknown'}) rejected: ${message}`);
    }

    // Emitting is itself I/O on a socket that may have just died — which is a
    // plausible cause of the failure being handled. A throw here would land
    // back in the same place and loop.
    try {
      client?.emit('error', { message, event });
    } catch (err) {
      this.logger.warn(`could not notify socket ${client?.id ?? 'unknown'}: ${describe(err)}`);
    }
  }
}

/**
 * What the client is told, and how loudly we log it.
 *
 * A deliberately thrown HttpException carries a message written for a caller
 * (`forbidden`, `unknown clinic`) and is safe to forward. Everything else is
 * ours, and the client gets a generic line.
 */
function resolve(exception: unknown): { message: string; logAs: 'warn' | 'error' } {
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const payload = exception.getResponse();
    const message =
      typeof payload === 'string'
        ? payload
        : ((payload as { message?: unknown }).message ?? exception.message);
    return {
      message: Array.isArray(message) ? message.join(', ') : String(message),
      logAs: status >= 500 ? 'error' : 'warn',
    };
  }

  // The database is unreachable or slow: the client should retry, not treat the
  // room as forbidden and give up.
  if (
    exception instanceof Prisma.PrismaClientInitializationError ||
    isConnectionError(exception)
  ) {
    return { message: 'service temporarily unavailable, please retry', logAs: 'error' };
  }

  return { message: 'internal server error', logAs: 'error' };
}

/** Network-level failures reaching a dependency (Postgres, Redis, …). */
function isConnectionError(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  return (
    typeof code === 'string' &&
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'EPIPE'].includes(code)
  );
}

/** Short, log-safe description of anything that can be thrown. */
function describe(e: unknown): string {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    return `${e.code} ${e.message.split('\n')[0]}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
