import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { DEV_OTP_CODE, OtpService } from '../src/auth/otp.service';
import { maskMobile, Msg91SmsSender } from '../src/auth/sms.sender';
import { RedisService } from '../src/common/redis/redis.service';
import { ProductionConfigError } from '../src/common/config/production-config.validator';
import { MetricsService } from '../src/common/observability/metrics.service';

/**
 * P0-4 — the static OTP fallback must be unreachable in production, and no OTP
 * value may ever reach a log.
 *
 * The original behaviour: with MSG91_AUTH_KEY unset, every account in the
 * system opened with '000000', and the code was written to the container log
 * alongside the mobile number. Because verifyPatientOtp upserts a patient by
 * mobile, that was mass account takeover.
 *
 * Uses an in-memory Redis double so this stays a pure unit test.
 */

const MOBILE = '9876543210';

/** Minimal Redis stand-in covering only what OtpService touches. */
function fakeRedis() {
  const store = new Map<string, string>();
  const redis = {
    incr: async (k: string) => {
      const next = Number(store.get(k) ?? '0') + 1;
      store.set(k, String(next));
      return next;
    },
    expire: async () => 1,
    set: async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    },
    del: async (k: string) => {
      store.delete(k);
      return 1;
    },
  };
  return {
    service: {
      redis,
      defineCommand: () => undefined,
    } as unknown as RedisService,
    store,
  };
}

function makeService(authKey?: string, sms?: { sendOtp: jest.Mock }) {
  const { service, store } = fakeRedis();
  const config = {
    get: (key: string, fallback?: unknown) =>
      key === 'MSG91_AUTH_KEY' ? authKey : fallback,
  } as unknown as ConfigService;
  const sender = sms ?? { sendOtp: jest.fn(async () => undefined) };
  // Real registry: OtpService counts failed verifications, and a stub would let
  // a broken metric label pass unnoticed here.
  const metrics = new MetricsService();
  return {
    otp: new OtpService(service, config, sender as never, metrics),
    store,
    sender,
  };
}

describe('OTP static-code fallback', () => {
  const original = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = original;
    jest.restoreAllMocks();
  });

  it('REFUSES to issue an OTP in production when MSG91_AUTH_KEY is missing', async () => {
    process.env.NODE_ENV = 'production';
    const { otp, sender } = makeService(undefined);

    await expect(otp.requestOtp(MOBILE)).rejects.toThrow(ProductionConfigError);
    // and nothing was sent, so no account was left reachable by a known code
    expect(sender.sendOtp).not.toHaveBeenCalled();
  });

  it('issues a RANDOM code in production when MSG91_AUTH_KEY is configured', async () => {
    process.env.NODE_ENV = 'production';
    const sent: string[] = [];
    const sender = { sendOtp: jest.fn(async (_m: string, code: string) => void sent.push(code)) };
    const { otp } = makeService('msg91-key', sender);

    // Several issues in a row must not all be the same value.
    await otp.requestOtp(MOBILE);
    await otp.requestOtp('9876543211');
    await otp.requestOtp('9876543212');

    expect(sent).toHaveLength(3);
    for (const code of sent) {
      expect(code).toMatch(/^\d{6}$/);
      expect(code).not.toBe(DEV_OTP_CODE);
    }
    expect(new Set(sent).size).toBeGreaterThan(1);
  });

  it('still allows the development fixed code outside production', async () => {
    process.env.NODE_ENV = 'test';
    const sender = { sendOtp: jest.fn(async () => undefined) };
    const { otp } = makeService(undefined, sender);

    await otp.requestOtp(MOBILE);
    expect(sender.sendOtp).toHaveBeenCalledWith(MOBILE, DEV_OTP_CODE);
  });

  it('never stores the OTP in plaintext — only a hash', async () => {
    process.env.NODE_ENV = 'test';
    const { otp, store } = makeService(undefined);
    await otp.requestOtp(MOBILE);

    const values = [...store.values()];
    expect(values).not.toContain(DEV_OTP_CODE);
    // sha256 hex of the code is what is kept
    expect(values.some((v) => /^[0-9a-f]{64}$/.test(v))).toBe(true);
  });
});

describe('SMS sender logging', () => {
  const original = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = original;
    jest.restoreAllMocks();
  });

  const sender = (authKey?: string) =>
    new Msg91SmsSender(
      {
        get: (key: string) => (key === 'MSG91_AUTH_KEY' ? authKey : undefined),
      } as unknown as ConfigService,
      new MetricsService(),
    );

  it('does not log the OTP value in the development fallback', async () => {
    process.env.NODE_ENV = 'development';
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await sender(undefined).sendOtp(MOBILE, '123456');

    expect(warn).toHaveBeenCalled();
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('123456');
    expect(logged).not.toContain(MOBILE); // full number is redacted too
  });

  it('refuses the development SMS fallback in production', async () => {
    process.env.NODE_ENV = 'production';
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(sender(undefined).sendOtp(MOBILE, '123456')).rejects.toThrow(
      ProductionConfigError,
    );
  });
});

describe('maskMobile', () => {
  it('keeps only the last four digits', () => {
    expect(maskMobile('9876543210')).toBe('******3210');
  });

  it('handles formatting characters and country codes', () => {
    expect(maskMobile('+91 98765-43210')).toBe('********3210');
  });

  it('does not leak anything for very short input', () => {
    expect(maskMobile('12')).toBe('****');
  });
});
