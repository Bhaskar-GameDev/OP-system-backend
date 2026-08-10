import { ConsoleLogger, LoggerService, LogLevel } from '@nestjs/common';
import { currentRequestId } from './request-context';

/** Anything a line of text can be written to (process.stdout, or a test spy). */
export interface LineSink {
  write(chunk: string): unknown;
}

/**
 * One-line-per-event JSON logger for production.
 *
 * Nest's default logger writes a human-formatted line with colour codes. That is
 * right for a terminal and wrong for a log shipper: the message, the context and
 * the severity all end up in one string that has to be re-parsed with a regex,
 * and there is nowhere to put a correlation id. The voice agent already emits
 * structured JSON with a `callSid` key; this brings the backend to the same
 * shape so both can be queried the same way.
 *
 * Development keeps the pretty logger — see `createLogger`.
 */
export class JsonLogger implements LoggerService {
  /**
   * Sinks are the only thing this class does I/O through, so a test can capture
   * lines without spying on the process streams.
   */
  constructor(
    private readonly out: LineSink = process.stdout,
    private readonly err: LineSink = process.stderr,
  ) {}

  log(message: unknown, context?: unknown): void {
    this.emit('info', message, context);
  }
  warn(message: unknown, context?: unknown): void {
    this.emit('warn', message, context);
  }
  error(message: unknown, stack?: unknown, context?: unknown): void {
    this.emit('error', message, context, typeof stack === 'string' ? stack : undefined);
  }
  debug(message: unknown, context?: unknown): void {
    this.emit('debug', message, context);
  }
  verbose(message: unknown, context?: unknown): void {
    this.emit('verbose', message, context);
  }

  private emit(
    level: LogLevel | 'info',
    message: unknown,
    context?: unknown,
    stack?: string,
  ): void {
    const line = JSON.stringify({
      t: new Date().toISOString(),
      level,
      // Present only inside a request. Cron jobs and socket handlers legitimately
      // have none, and an invented id would be worse than an absent one.
      requestId: currentRequestId(),
      ctx: typeof context === 'string' ? context : undefined,
      msg: typeof message === 'string' ? message : safeStringify(message),
      stack,
    });
    (level === 'error' ? this.err : this.out).write(`${line}\n`);
  }
}

/**
 * Production logs JSON; development keeps Nest's readable output, because a
 * developer reading a terminal is not the audience a log shipper is.
 */
export function createLogger(nodeEnv = process.env.NODE_ENV): LoggerService {
  return nodeEnv === 'production' ? new JsonLogger() : new ConsoleLogger();
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
