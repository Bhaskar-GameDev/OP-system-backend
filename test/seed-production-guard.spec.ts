import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * P0-5 — the demo seed must be unable to run against production.
 *
 * The seed creates staff accounts with documented passwords (including a
 * super-admin) and issues deleteMany against bookings, booking history, audit
 * logs, doctors and clinics. On a live hospital database that is simultaneously
 * an authentication bypass and destruction of patient bookings.
 *
 * These tests execute the real script in a subprocess rather than importing it,
 * because the guard's whole job is to stop the process before it connects.
 */

const BACKEND_ROOT = join(__dirname, '..');
const SEED_PATH = join(BACKEND_ROOT, 'prisma', 'seed.ts');

describe('seed production guard', () => {
  it('refuses to run and exits non-zero when NODE_ENV=production', () => {
    let exitCode = 0;
    let output = '';
    try {
      // Run through node directly with the ts-node register hook rather than
      // `npx`, which is a shell shim and reports spawn failures as a missing
      // exit status — indistinguishable from the guard not firing.
      output = execFileSync(
        process.execPath,
        ['-r', 'ts-node/register/transpile-only', SEED_PATH],
        {
          cwd: BACKEND_ROOT,
          env: {
            ...process.env,
            NODE_ENV: 'production',
            // Deliberately point at a database that does not exist. If the
            // guard fails, the script reaches Prisma and errors on connection
            // instead — a different message, which this test would catch.
            DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:1/should_never_connect',
          },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      exitCode = e.status ?? -1;
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }

    expect(exitCode).toBe(1);
    expect(output).toMatch(/Refusing to seed/i);
    expect(output).toMatch(/NODE_ENV=production/);
    // It must have stopped BEFORE touching the database.
    expect(output).not.toMatch(/Can't reach database server/i);
    expect(output).not.toMatch(/Demo seed complete/i);
  }, 120_000);
});

/**
 * P0-6 — seeded credentials must not be printable or hardcoded beyond the
 * documented dev defaults, and the demo seed is the only place they exist.
 */
describe('seed credential handling', () => {
  const source = readFileSync(SEED_PATH, 'utf8');

  it('contains NO hardcoded privileged password anywhere', () => {
    // P0.6: these strings were published in a PUBLIC repository as working
    // credentials for admin, super-admin, reception and doctor accounts. They
    // must not survive here in any form — not as a fallback, not in a comment
    // that reads like an instruction, not in a log line.
    for (const secret of ['admin123', 'superadmin123', 'reception123', 'doctor123']) {
      expect(source).not.toContain(secret);
    }
  });

  it('never passes a string literal to bcrypt.hash', () => {
    // Any literal reaching the hasher would be a shared, reusable credential
    // by definition — which is the design this task removed.
    const directHashes = source.match(/bcrypt\.hash\(\s*['"][^'"]+['"]/g) ?? [];
    expect(directHashes).toHaveLength(0);
  });

  it('generates passwords from a CSPRNG when none is supplied', () => {
    expect(source).toContain('randomBytes(');
    expect(source).toContain('devPassword(');
  });

  it('does not print generated credentials when NODE_ENV=production', () => {
    // Guarded independently of assertSafeToSeed, so a future refactor that
    // reorders the script still cannot leak a credential into a log.
    const reporter = source.slice(source.indexOf('function reportGeneratedCredentials'));
    const guardAt = reporter.indexOf("NODE_ENV === 'production'");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(reporter.indexOf('console.log'));
  });

  it('gives privileged accounts generated ids, not predictable fixed ones', () => {
    // Staff and doctors are upserted by their unique username while the primary
    // key is generated. The fixed ids that remain are hospitals and clinics,
    // which carry no credential — and HOSPITAL_A's is a production identifier
    // written by migration 20260626130000, so it must NOT change.
    expect(source).toContain('randomUUID()');
    expect(source).toContain('where: { username: m.username }');
    expect(source).toContain('where: { username: d.username }');

    const privilegedFixedIds =
      source.match(
        /(STAFF_[A-Z_]*|SUPER_ADMIN|DR_[A-Z_]*)\s*=\s*'00000000-0000-0000-0000-[0-9a-f]+'/g,
      ) ?? [];
    expect(privilegedFixedIds).toHaveLength(0);
  });

  it('calls the production guard before any database work', () => {
    const guardIndex = source.indexOf('assertSafeToSeed();');
    const firstPrismaCall = source.indexOf('await cleanupLegacy();');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(firstPrismaCall);
  });
});

/**
 * The Docker entrypoint is the outermost of the three locks. Assert its default
 * is OFF, since that single character was the original production blocker.
 */
describe('docker entrypoint seed default', () => {
  const entrypoint = readFileSync(join(BACKEND_ROOT, 'docker-entrypoint.sh'), 'utf8');

  it('defaults SEED_ON_START to false', () => {
    expect(entrypoint).toContain('${SEED_ON_START:-false}');
    expect(entrypoint).not.toContain('${SEED_ON_START:-true}');
  });

  it('aborts when seeding is requested in production', () => {
    expect(entrypoint).toMatch(/NODE_ENV.*=.*"production"/);
    expect(entrypoint).toMatch(/exit 1/);
  });
});
