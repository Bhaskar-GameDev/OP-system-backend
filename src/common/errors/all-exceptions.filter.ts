import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

// Structural shapes rather than `import type { Request, Response } from 'express'`
// — @types/express is not a dependency here, and these are the only members the
// filter touches.
interface HttpRequestLike {
  method?: string;
  url?: string;
}
interface HttpResponseLike {
  headersSent: boolean;
  status(code: number): HttpResponseLike;
  json(body: unknown): unknown;
  end(): unknown;
}

/**
 * Last line of defence for every HTTP request.
 *
 * Without this, anything that isn't an HttpException — a Prisma constraint
 * violation, a Redis timeout, a TypeError — leaves Nest to render a bare 500
 * whose body carries the raw driver message. That is two problems at once: it
 * leaks schema/internals to whoever called (including the public patient app),
 * and it gives the caller nothing actionable.
 *
 * Rules:
 *  - HttpException (thrown deliberately by our services) passes through
 *    untouched — those messages are written for the caller.
 *  - Known Prisma error codes map to the HTTP status they actually mean, so a
 *    duplicate booking reads 409 instead of 500 and clients can branch on it.
 *  - Everything else becomes a generic 500. The real error is logged with the
 *    stack server-side; the response body never carries it.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('UnhandledException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<HttpResponseLike>();
    const req = ctx.getRequest<HttpRequestLike>();

    const { status, body, logAs } = this.resolve(exception);

    // 5xx is our bug and gets a stack; 4xx is the caller's and stays quiet at
    // warn — a 404 storm must not drown the log that matters.
    const where = `${req.method} ${req.url}`;
    if (logAs === 'error') {
      this.logger.error(
        `${where} -> ${status}: ${describe(exception)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(`${where} -> ${status}: ${describe(exception)}`);
    }

    // The response may already be streaming (SSE / realtime endpoints); writing
    // headers again would throw inside the filter itself.
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(status).json({
      statusCode: status,
      path: req.url,
      timestamp: new Date().toISOString(),
      ...body,
    });
  }

  private resolve(exception: unknown): {
    status: number;
    body: Record<string, unknown>;
    logAs: 'warn' | 'error';
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      return {
        status,
        body: typeof payload === 'string' ? { message: payload } : (payload as Record<string, unknown>),
        logAs: status >= HttpStatus.INTERNAL_SERVER_ERROR ? 'error' : 'warn',
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = mapPrisma(exception);
      if (mapped) {
        return { status: mapped.status, body: { message: mapped.message }, logAs: 'warn' };
      }
    }

    // Bad input Prisma rejected before it ever reached the database — the
    // caller's fault, not ours, so 400 rather than a 500 that pages someone.
    if (exception instanceof Prisma.PrismaClientValidationError) {
      return { status: HttpStatus.BAD_REQUEST, body: { message: 'invalid request data' }, logAs: 'warn' };
    }

    // Database/Redis unreachable: the request is retryable, so say so with 503
    // instead of a flat 500 that clients treat as permanent.
    if (
      exception instanceof Prisma.PrismaClientInitializationError ||
      isConnectionError(exception)
    ) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        body: { message: 'service temporarily unavailable, please retry' },
        logAs: 'error',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { message: 'internal server error' },
      logAs: 'error',
    };
  }
}

/** Prisma error codes we can state something honest about. */
function mapPrisma(
  e: Prisma.PrismaClientKnownRequestError,
): { status: number; message: string } | null {
  switch (e.code) {
    case 'P2002': // unique constraint
      return { status: HttpStatus.CONFLICT, message: 'that record already exists' };
    case 'P2025': // record required by the operation was not found
      return { status: HttpStatus.NOT_FOUND, message: 'record not found' };
    case 'P2003': // foreign key constraint
      return { status: HttpStatus.BAD_REQUEST, message: 'referenced record does not exist' };
    case 'P2034': // write conflict / deadlock — genuinely worth retrying
      return { status: HttpStatus.CONFLICT, message: 'write conflict, please retry' };
    default:
      return null;
  }
}

/** Network-level failures reaching a dependency (Postgres, Redis, MSG91, …). */
function isConnectionError(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  return (
    typeof code === 'string' &&
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'EPIPE'].includes(code)
  );
}

/** Short, log-safe description of anything that can be thrown. */
function describe(e: unknown): string {
  if (e instanceof Prisma.PrismaClientKnownRequestError) return `${e.code} ${e.message.split('\n')[0]}`;
  if (e instanceof Error) return e.message;
  return String(e);
}
