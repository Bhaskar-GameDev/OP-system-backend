import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { selectRazorpayGateway } from '../src/payments/payments.module';
import {
  FakeRazorpayGateway,
  HttpRazorpayGateway,
  hmacEquals,
} from '../src/payments/razorpay.gateway';
import { ProductionConfigError } from '../src/common/config/production-config.validator';

/**
 * P0-3 — the fake payment gateway must be unreachable in production.
 *
 * FakeRazorpayGateway returns true from BOTH signature checks unconditionally.
 * Selecting it in production means forged checkout confirmations and forged
 * webhooks are accepted, so every one of these tests guards real money.
 *
 * Pure — no DB, no network.
 */

const FULL_CREDS: Record<string, string> = {
  RAZORPAY_KEY_ID: 'rzp_live_id',
  RAZORPAY_KEY_SECRET: 'rzp_live_secret',
  RAZORPAY_WEBHOOK_SECRET: 'rzp_webhook_secret',
};

function cfg(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, fallback?: string) => values[key] ?? fallback,
  } as unknown as ConfigService;
}

describe('Razorpay gateway selection', () => {
  const original = process.env.NODE_ENV;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.env.NODE_ENV = original;
    jest.restoreAllMocks();
  });

  it('production + full credentials selects the REAL gateway', () => {
    process.env.NODE_ENV = 'production';
    expect(selectRazorpayGateway(cfg(FULL_CREDS))).toBeInstanceOf(HttpRazorpayGateway);
  });

  it('production NEVER selects the fake gateway, even with no credentials', () => {
    process.env.NODE_ENV = 'production';
    // It must throw rather than quietly downgrade — and the thing it throws
    // must not be a working fake.
    expect(() => selectRazorpayGateway(cfg())).toThrow(ProductionConfigError);
  });

  it.each(Object.keys(FULL_CREDS))(
    'production fails to start when %s is missing',
    (missingKey) => {
      process.env.NODE_ENV = 'production';
      const partial = { ...FULL_CREDS };
      delete partial[missingKey];
      expect(() => selectRazorpayGateway(cfg(partial))).toThrow(missingKey);
    },
  );

  it('production refuses direct construction of the fake gateway', () => {
    process.env.NODE_ENV = 'production';
    expect(() => new FakeRazorpayGateway()).toThrow(ProductionConfigError);
  });

  it('development selects the fake gateway when no key id is configured', () => {
    process.env.NODE_ENV = 'development';
    expect(selectRazorpayGateway(cfg())).toBeInstanceOf(FakeRazorpayGateway);
  });

  it('development selects the real gateway when keys ARE configured', () => {
    process.env.NODE_ENV = 'development';
    expect(selectRazorpayGateway(cfg(FULL_CREDS))).toBeInstanceOf(HttpRazorpayGateway);
  });
});

describe('hmacEquals signature verification', () => {
  const secret = 'a-real-webhook-secret';
  const payload = '{"event":"payment.captured"}';
  // Precomputed with the same algorithm the gateway uses.
  const validSignature = createHmac('sha256', secret).update(payload).digest('hex');

  it('accepts a correct signature', () => {
    expect(hmacEquals(secret, payload, validSignature)).toBe(true);
  });

  it('rejects a forged signature', () => {
    expect(hmacEquals(secret, payload, 'f'.repeat(64))).toBe(false);
  });

  it('rejects a signature for different content (tampered body)', () => {
    expect(hmacEquals(secret, '{"event":"refund.processed"}', validSignature)).toBe(false);
  });

  it('FAILS CLOSED when the secret is unset rather than verifying against a blank key', () => {
    // HMAC with an empty key is still deterministic, so without this guard an
    // attacker who noticed the blank could compute a passing signature.
    const blankKeySignature = createHmac('sha256', '').update(payload).digest('hex');
    expect(hmacEquals('', payload, blankKeySignature)).toBe(false);
  });
});
