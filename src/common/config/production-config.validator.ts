/**
 * Production configuration gate — the system's fail-closed boundary.
 *
 * Every security-relevant integration in this backend has a development
 * fallback: the payment gateway falls back to a fake that accepts any
 * signature, OTP falls back to a fixed code, push falls back to a log line, and
 * the token signer used to fall back to a hardcoded string. Each fallback is
 * keyed on "is the environment variable present", which means a single missing
 * or misspelled line in .env.production silently produces a healthy-looking
 * server with no authentication, no payment verification, and a universal OTP.
 *
 * This module makes that impossible. Under NODE_ENV=production the process
 * refuses to start unless every required secret is present AND passes its
 * strength rules. Nothing here reads a value into an error message — only names
 * are reported, so a validation failure can be pasted into a ticket safely.
 *
 * Deliberately a pure function over an env record rather than a Nest provider:
 * it must run BEFORE the Nest container is built, so a misconfigured process
 * never reaches the point of opening a database connection or binding a port.
 */

/** Thrown when production configuration is missing or unsafe. Never carries a value. */
export class ProductionConfigError extends Error {
  constructor(
    message: string,
    readonly missing: string[],
    readonly insecure: string[],
  ) {
    super(message);
    this.name = 'ProductionConfigError';
  }
}

/**
 * Secrets with no safe default. Absent (or blank) in production means the
 * feature they guard would silently degrade to its development fake, so the
 * process must not start.
 */
export const REQUIRED_PRODUCTION_VARS = [
  'JWT_SECRET',
  'MSG91_AUTH_KEY',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'DATABASE_URL',
  'REDIS_PASSWORD',
] as const;

/** Minimum entropy we accept for the token signing key, in characters. */
export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Minimum entropy for HOSPITAL_SETUP_KEY. Optional (absent = the tenant-setup
 * route is disabled), but when present it is the ONLY thing standing in front of
 * an unauthenticated route that creates a hospital and an ADMIN login, so a short
 * or placeholder value is worse than not having the feature at all.
 */
export const MIN_SETUP_KEY_LENGTH = 32;

/**
 * Values that must never sign a production token. These are the strings this
 * repository has actually shipped as defaults or templates plus the obvious
 * placeholders; matching is case-insensitive and whitespace-trimmed so
 * "Dev_Secret " is rejected too.
 */
const UNSAFE_SECRET_VALUES = new Set([
  'dev_secret',
  'devsecret',
  'secret',
  'changeme',
  'change_me',
  'test',
  'test_secret',
  'password',
  'replace_me_with_long_random_string',
  'your_secret_here',
  'todo',
]);

/** True when this process is running as production. Single definition, used everywhere. */
export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production';
}

/**
 * Reject a signing secret that is absent, too short, or a known placeholder.
 * Returns null when acceptable, otherwise a reason with NO value in it.
 */
export function jwtSecretProblem(secret: string | undefined): string | null {
  const value = (secret ?? '').trim();
  if (value.length === 0) return null; // absence is reported as "missing", not "insecure"
  if (UNSAFE_SECRET_VALUES.has(value.toLowerCase())) {
    return 'JWT_SECRET is a known development placeholder';
  }
  if (value.length < MIN_JWT_SECRET_LENGTH) {
    return `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters`;
  }
  return null;
}

/**
 * Reject a tenant-setup key that is too short or a known placeholder. Absence is
 * fine and is NOT a problem — it simply means POST /setup/hospital is disabled.
 * Returns null when acceptable, otherwise a reason with NO value in it.
 */
export function setupKeyProblem(key: string | undefined): string | null {
  const value = (key ?? '').trim();
  if (value.length === 0) return null; // feature off, nothing to validate
  if (UNSAFE_SECRET_VALUES.has(value.toLowerCase())) {
    return 'HOSPITAL_SETUP_KEY is a known development placeholder';
  }
  if (value.length < MIN_SETUP_KEY_LENGTH) {
    return `HOSPITAL_SETUP_KEY must be at least ${MIN_SETUP_KEY_LENGTH} characters`;
  }
  return null;
}

/** Join names the way a human would read them: "A", "A and B", "A, B and C". */
function humanList(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Validate production configuration. No-op outside production, so development
 * and the test suite keep their intentional fallbacks.
 *
 * Reports EVERY problem at once — a deploy that is missing four secrets should
 * learn that in one restart, not four.
 *
 * @throws {ProductionConfigError} when anything required is missing or unsafe.
 */
export function validateProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (!isProduction(env)) return;

  const missing: string[] = [];
  const insecure: string[] = [];

  for (const name of REQUIRED_PRODUCTION_VARS) {
    if (!(env[name] ?? '').trim()) missing.push(name);
  }

  const jwtProblem = jwtSecretProblem(env.JWT_SECRET);
  if (jwtProblem) insecure.push(jwtProblem);

  const setupProblem = setupKeyProblem(env.HOSPITAL_SETUP_KEY);
  if (setupProblem) insecure.push(setupProblem);

  // Seeding in production creates predictable staff accounts and issues
  // deleteMany against live rows (see prisma/seed.ts). The seed script refuses
  // to run in production on its own; this catches the flag at startup so the
  // container fails loudly rather than starting with a seed attempt behind it.
  if ((env.SEED_ON_START ?? '').trim().toLowerCase() === 'true') {
    insecure.push('SEED_ON_START must not be true in production');
  }

  if (missing.length === 0 && insecure.length === 0) return;

  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`${humanList(missing)} ${missing.length === 1 ? 'is' : 'are'} missing`);
  }
  if (insecure.length > 0) parts.push(insecure.join('; '));

  throw new ProductionConfigError(
    `Production configuration validation failed: ${parts.join('. ')}.`,
    missing,
    insecure,
  );
}

/**
 * Guard for a development-only implementation (fake payment gateway, static
 * OTP, log-only push). Call this at the point of substitution so the fake can
 * never be constructed in production, independently of whether the validator
 * above happened to run.
 *
 * Defence in depth on purpose: the validator protects the normal boot path,
 * this protects every other path (a worker, a script, a future entrypoint).
 */
export function assertNotProduction(feature: string, env: NodeJS.ProcessEnv = process.env): void {
  if (isProduction(env)) {
    throw new ProductionConfigError(
      `${feature} is a development-only fallback and must never run in production. ` +
        'Configure the real provider credentials.',
      [],
      [feature],
    );
  }
}
