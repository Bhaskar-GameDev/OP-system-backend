import { ConsoleLogger, LoggerService, LogLevel } from '@nestjs/common';
import { currentRequestId } from './request-context';

/** Anything a line of text can be written to (process.stdout, or a test spy). */
export interface LineSink {
  write(chunk: string): unknown;
}

/**
 * Severity order used for threshold filtering. Nest's own level names are kept
 * (so `logLevels` and this agree), with `log` reported as `info` on the wire to
 * match the voice agent and the client apps.
 */
const ORDER: Record<string, number> = {
  verbose: 10,
  debug: 20,
  log: 30,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/** The levels Nest should keep, for a given threshold. */
export function enabledLevels(threshold: LogLevel): LogLevel[] {
  const all: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];
  const floor = ORDER[threshold] ?? ORDER.log;
  return all.filter((level) => (ORDER[level] ?? ORDER.log) >= floor);
}

function isLevel(value: unknown): value is LogLevel {
  return (
    value === 'verbose' ||
    value === 'debug' ||
    value === 'log' ||
    value === 'warn' ||
    value === 'error' ||
    value === 'fatal'
  );
}

/**
 * Threshold from the environment: `LOG_LEVEL` wins, otherwise production keeps
 * `log` and above while development keeps everything.
 *
 * Without this, `logger.debug()` in a hot path (queue recompute, socket fan-out)
 * wrote a JSON line per call in production — noise that costs disk and hides
 * the lines that matter. `LOG_LEVEL=debug` turns it back on for one deploy
 * without a code change.
 */
export function resolveLogLevel(
  configured: string | undefined = process.env.LOG_LEVEL,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): LogLevel {
  const value = configured?.trim().toLowerCase();
  if (value === 'info') return 'log';
  if (isLevel(value)) return value;
  return nodeEnv === 'production' ? 'log' : 'verbose';
}

/**
 * Scrubs applied to every message and stack before it is written.
 *
 * A log line is written by whoever was closest to the failure, and the thing
 * closest to a failure here is frequently a session token or the patient's
 * phone number — interpolated into a message, or quoted inside a driver error.
 * The client apps and the voice agent scrub the same three shapes, so no tier
 * is the one that leaks. This is a backstop, not permission to log secrets.
 */
const VALUE_SCRUBS: Array<{ pattern: RegExp; with: string }> = [
  { pattern: /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, with: '[redacted]' },
  // Indian mobile numbers. Deliberately not a generic long-digit run: epoch
  // milliseconds and ids are 10+ digits and must stay readable.
  { pattern: /(?:\+?91[-\s]?)?\b[6-9]\d{9}\b/g, with: '[redacted]' },
  { pattern: /([?&](?:access_)?token=)[^&\s]+/gi, with: '$1[redacted]' },
];

/** Apply {@link VALUE_SCRUBS} to a string. */
export function scrubLogText(value: string): string {
  let out = value;
  for (const rule of VALUE_SCRUBS) out = out.replace(rule.pattern, rule.with);
  return out;
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
    /**
     * Levels below this are dropped. Defaults to the environment's threshold —
     * a caller passing only sinks (tests) keeps the previous "log everything"
     * behaviour in a non-production NODE_ENV.
     */
    private readonly threshold: LogLevel = resolveLogLevel(),
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
    if ((ORDER[level] ?? ORDER.log) < (ORDER[this.threshold] ?? ORDER.log)) return;

    const line = JSON.stringify({
      t: new Date().toISOString(),
      level,
      // Present only inside a request. Cron jobs and socket handlers legitimately
      // have none, and an invented id would be worse than an absent one.
      requestId: currentRequestId(),
      ctx: typeof context === 'string' ? context : undefined,
      msg: scrubLogText(typeof message === 'string' ? message : safeStringify(message)),
      stack: stack === undefined ? undefined : scrubLogText(stack),
    });
    (level === 'error' ? this.err : this.out).write(`${line}\n`);
  }
}

/**
 * Production logs JSON; development keeps Nest's readable output, because a
 * developer reading a terminal is not the audience a log shipper is.
 *
 * Both honour the same `LOG_LEVEL` threshold, so "turn the noise down" (or up,
 * to chase a bug) is one env var and means the same thing in either mode.
 */
export function createLogger(nodeEnv = process.env.NODE_ENV): LoggerService {
  const threshold = resolveLogLevel(process.env.LOG_LEVEL, nodeEnv);
  if (nodeEnv === 'production') return new JsonLogger(process.stdout, process.stderr, threshold);
  const logger = new ConsoleLogger();
  logger.setLogLevels(enabledLevels(threshold));
  return logger;
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
