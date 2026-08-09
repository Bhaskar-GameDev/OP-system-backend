import { ConfigService } from '@nestjs/config';
import {
  assertNotProduction,
  isProduction,
  jwtSecretProblem,
  MIN_JWT_SECRET_LENGTH,
  ProductionConfigError,
  REQUIRED_PRODUCTION_VARS,
  validateProductionConfig,
} from '../src/common/config/production-config.validator';
import { AuthTokenService } from '../src/auth/auth-token.service';

/**
 * P0-1 / P0-2 — the fail-closed configuration boundary.
 *
 * The system's core security risk was that EVERY integration degraded silently
 * to a development fake when its environment variable was absent. These tests
 * lock the inverted rule: in production, missing or weak configuration must
 * stop the process, and no error may ever contain a secret value.
 *
 * Pure — no DB, no Redis. Env records are passed in explicitly rather than
 * mutated globally, so the suite cannot leak state into other suites.
 */

const STRONG_SECRET = 'x'.repeat(MIN_JWT_SECRET_LENGTH + 8);

/** A complete, valid production environment. Values are obvious fakes. */
function validProdEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    JWT_SECRET: STRONG_SECRET,
    MSG91_AUTH_KEY: 'msg91-key',
    RAZORPAY_KEY_ID: 'rzp_live_id',
    RAZORPAY_KEY_SECRET: 'rzp_live_secret',
    RAZORPAY_WEBHOOK_SECRET: 'rzp_webhook_secret',
    DATABASE_URL: 'postgresql://u:p@db:5432/x',
    REDIS_PASSWORD: 'redis-password',
  };
}

describe('validateProductionConfig', () => {
  it('passes with a complete production environment', () => {
    expect(() => validateProductionConfig(validProdEnv())).not.toThrow();
  });

  it('is a no-op outside production so development keeps its fallbacks', () => {
    expect(() => validateProductionConfig({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => validateProductionConfig({ NODE_ENV: 'test' })).not.toThrow();
    expect(() => validateProductionConfig({})).not.toThrow();
  });

  it.each(REQUIRED_PRODUCTION_VARS)('fails in production when %s is missing', (name) => {
    const env = validProdEnv();
    delete env[name];
    expect(() => validateProductionConfig(env)).toThrow(ProductionConfigError);
  });

  it.each(REQUIRED_PRODUCTION_VARS)('treats a blank %s as missing', (name) => {
    const env = validProdEnv();
    env[name] = '   ';
    expect(() => validateProductionConfig(env)).toThrow(ProductionConfigError);
  });

  it('reports every missing variable together, not one per restart', () => {
    const env = validProdEnv();
    delete env.JWT_SECRET;
    delete env.DATABASE_URL;
    delete env.REDIS_PASSWORD;

    try {
      validateProductionConfig(env);
      fail('expected validation to throw');
    } catch (err) {
      const e = err as ProductionConfigError;
      expect(e.missing).toEqual(
        expect.arrayContaining(['JWT_SECRET', 'DATABASE_URL', 'REDIS_PASSWORD']),
      );
      expect(e.message).toContain('JWT_SECRET');
      expect(e.message).toContain('DATABASE_URL');
      expect(e.message).toContain('REDIS_PASSWORD');
      expect(e.message).toContain('and'); // reads as a list, not a dump
    }
  });

  it('never puts a secret VALUE in the error message', () => {
    const env = validProdEnv();
    env.JWT_SECRET = 'dev_secret';
    env.RAZORPAY_KEY_SECRET = 'super-secret-live-value';
    delete env.MSG91_AUTH_KEY;

    try {
      validateProductionConfig(env);
      fail('expected validation to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain('dev_secret');
      expect(message).not.toContain('super-secret-live-value');
      expect(message).toContain('JWT_SECRET'); // the NAME is fine
    }
  });

  it('rejects SEED_ON_START=true in production', () => {
    const env = { ...validProdEnv(), SEED_ON_START: 'true' };
    expect(() => validateProductionConfig(env)).toThrow(/SEED_ON_START/);
  });

  it('allows SEED_ON_START=false in production', () => {
    const env = { ...validProdEnv(), SEED_ON_START: 'false' };
    expect(() => validateProductionConfig(env)).not.toThrow();
  });
});

describe('jwtSecretProblem', () => {
  it('accepts a sufficiently long random secret', () => {
    expect(jwtSecretProblem(STRONG_SECRET)).toBeNull();
  });

  it.each([
    'dev_secret',
    'DEV_SECRET',
    '  dev_secret  ',
    'secret',
    'changeme',
    'test',
    'password',
    'replace_me_with_long_random_string',
  ])('rejects the known placeholder %p', (value) => {
    expect(jwtSecretProblem(value)).toMatch(/placeholder/);
  });

  it('rejects a short secret even when it is not a known placeholder', () => {
    expect(jwtSecretProblem('a1b2c3d4')).toMatch(/at least/);
  });

  it('reports absence as null so it is counted as missing, not weak', () => {
    expect(jwtSecretProblem(undefined)).toBeNull();
    expect(jwtSecretProblem('')).toBeNull();
  });
});

describe('assertNotProduction', () => {
  it('throws in production', () => {
    expect(() => assertNotProduction('FakeThing', { NODE_ENV: 'production' })).toThrow(
      ProductionConfigError,
    );
  });

  it('permits the fallback in development and test', () => {
    expect(() => assertNotProduction('FakeThing', { NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertNotProduction('FakeThing', { NODE_ENV: 'test' })).not.toThrow();
  });
});

describe('isProduction', () => {
  it('is true only for the exact string "production"', () => {
    expect(isProduction({ NODE_ENV: 'production' })).toBe(true);
    expect(isProduction({ NODE_ENV: 'Production' })).toBe(false);
    expect(isProduction({ NODE_ENV: 'staging' })).toBe(false);
    expect(isProduction({})).toBe(false);
  });
});

/**
 * Second lock: even if the bootstrap validator were bypassed (a worker, a
 * script, a future entrypoint), constructing the token signer in production
 * with a missing or unsafe secret must fail rather than sign with 'dev_secret'.
 */
describe('AuthTokenService secret handling', () => {
  const original = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  const svc = (secret?: string): AuthTokenService =>
    new AuthTokenService({
      get: (key: string) => (key === 'JWT_SECRET' ? secret : undefined),
    } as unknown as ConfigService);

  it('refuses to construct in production with no JWT_SECRET', () => {
    process.env.NODE_ENV = 'production';
    expect(() => svc(undefined)).toThrow(ProductionConfigError);
  });

  it('refuses to construct in production with the dev_secret placeholder', () => {
    process.env.NODE_ENV = 'production';
    expect(() => svc('dev_secret')).toThrow(/placeholder/);
  });

  it('refuses to construct in production with a weak JWT_SECRET', () => {
    process.env.NODE_ENV = 'production';
    expect(() => svc('short')).toThrow(/at least/);
  });

  it('constructs in production with a strong JWT_SECRET and signs verifiably', () => {
    process.env.NODE_ENV = 'production';
    const service = svc(STRONG_SECRET);
    const token = service.sign({ sub: 'p1', role: 'PATIENT' });
    expect(service.verify(token).sub).toBe('p1');
  });

  it('keeps working in test/development without a configured secret', () => {
    process.env.NODE_ENV = 'test';
    const service = svc(undefined);
    const token = service.sign({ sub: 'p1', role: 'PATIENT' });
    expect(service.verify(token).sub).toBe('p1');
  });

  it('does not accept a token signed with a different secret', () => {
    process.env.NODE_ENV = 'test';
    const token = svc(STRONG_SECRET).sign({ sub: 'p1', role: 'PATIENT' });
    expect(() => svc(`${STRONG_SECRET}-other`).verify(token)).toThrow();
  });
});
