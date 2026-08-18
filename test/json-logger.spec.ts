import {
  JsonLogger,
  enabledLevels,
  resolveLogLevel,
  scrubLogText,
} from '../src/common/observability/json-logger';

/**
 * The logger's own rules, tested without a database.
 *
 * `observability.spec.ts` covers the same class as part of a running app (it
 * needs Postgres and Redis for everything else it asserts). These properties —
 * what gets dropped, what gets scrubbed — are pure, and they are exactly the
 * ones that must still be checkable when no infrastructure is up.
 *
 * Properties locked in here:
 *   1. levels below the threshold are dropped, not merely quiet
 *   2. LOG_LEVEL resolves per environment, and rubbish falls back safely
 *   3. session tokens, phone numbers and token query params never reach a line
 *   4. the scrub is narrow enough to leave timestamps and ids readable
 */
describe('JsonLogger', () => {
  function capture(threshold?: Parameters<typeof enabledLevels>[0]) {
    const written: string[] = [];
    const sink = { write: (line: string) => written.push(line) };
    return {
      written,
      logger: threshold
        ? new JsonLogger(sink, sink, threshold)
        : new JsonLogger(sink, sink, 'verbose'),
      lines: () => written.map((l) => JSON.parse(l) as Record<string, unknown>),
    };
  }

  it('drops lines below the configured threshold', () => {
    // Without a threshold every debug() in a hot path (queue recompute, socket
    // fan-out) wrote a line in production, burying the ones that matter.
    const { logger, lines } = capture('warn');

    logger.verbose('trace', 'Ctx');
    logger.debug('detail', 'Ctx');
    logger.log('routine', 'Ctx');
    logger.warn('suspicious', 'Ctx');
    logger.error('broken', undefined, 'Ctx');

    expect(lines().map((l) => l.msg)).toEqual(['suspicious', 'broken']);
  });

  it('resolves the threshold from LOG_LEVEL, falling back per environment', () => {
    expect(resolveLogLevel('debug', 'production')).toBe('debug');
    // `info` is the name every other tier uses for Nest's `log`.
    expect(resolveLogLevel('info', 'production')).toBe('log');
    expect(resolveLogLevel(undefined, 'production')).toBe('log');
    expect(resolveLogLevel(undefined, 'development')).toBe('verbose');
    expect(resolveLogLevel('nonsense', 'production')).toBe('log');
  });

  it('translates a threshold into the level list Nest keeps', () => {
    expect(enabledLevels('warn')).toEqual(['warn', 'error', 'fatal']);
    expect(enabledLevels('verbose')).toEqual([
      'verbose',
      'debug',
      'log',
      'warn',
      'error',
      'fatal',
    ]);
  });

  it('scrubs session tokens and phone numbers out of messages and stacks', () => {
    // A log line is written by whoever is closest to the failure, and what is
    // closest to a failure here is frequently the patient's number or the token
    // that was rejected. Every tier scrubs the same three shapes.
    const { logger, lines } = capture('log');

    logger.error(
      'rejected eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig for 9876543210',
      'at GET /q?token=abc123',
      'AuthService',
    );

    expect(lines()[0]).toMatchObject({
      msg: 'rejected [redacted] for [redacted]',
      stack: 'at GET /q?token=[redacted]',
    });
  });

  it('keeps timestamps and ids readable while scrubbing', () => {
    // The phone scrub is deliberately narrow: a generic long-digit rule would
    // redact every epoch millisecond value and gut the logs.
    expect(scrubLogText('recomputed at 1755075300000 for W001 in 42ms')).toBe(
      'recomputed at 1755075300000 for W001 in 42ms',
    );
  });
});
