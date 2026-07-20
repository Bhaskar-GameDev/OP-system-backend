import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const RAZORPAY_GATEWAY = Symbol('RAZORPAY_GATEWAY');

export interface RpOrder {
  orderId: string;
  amount: number;
}
export interface RpPayment {
  id: string;
  orderId: string;
  status: string; // 'created' | 'authorized' | 'captured' | 'failed' | 'refunded'
  amount: number;
}
export interface RpRefund {
  refundId: string;
  status: string;
}

/**
 * Razorpay access. Swap impl (real REST vs sandbox fake) via RAZORPAY_GATEWAY.
 * Signature checks are the security boundary — implementations MUST verify with
 * the gateway secret, never trust client-supplied status.
 */
export interface RazorpayGateway {
  createOrder(amountPaise: number, receipt: string): Promise<RpOrder>;
  fetchPayment(paymentId: string): Promise<RpPayment>;
  refund(paymentId: string, amountPaise?: number): Promise<RpRefund>;
  /** checkout return: HMAC_SHA256(orderId|paymentId, KEY_SECRET). */
  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean;
  /** webhook: HMAC_SHA256(rawBody, WEBHOOK_SECRET). */
  verifyWebhookSignature(rawBody: string, signature: string): boolean;
}

/** Constant-time hex-HMAC compare. */
export function hmacEquals(
  secret: string,
  payload: string,
  signature: string,
): boolean {
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Real Razorpay via REST (no SDK dependency). Basic-auth with KEY_ID:KEY_SECRET.
 * Sandbox is just sandbox keys — same code path.
 */
@Injectable()
export class HttpRazorpayGateway implements RazorpayGateway {
  private readonly base = 'https://api.razorpay.com/v1';
  private readonly logger = new Logger(HttpRazorpayGateway.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Parse a Razorpay JSON response, throwing on a non-2xx so a 4xx/5xx never
   * silently yields an object with undefined fields. The full error body is
   * logged (Razorpay returns { error: { code, description, … } }).
   */
  private async parse<T>(res: Response, op: string): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      this.logger.error(`Razorpay ${op} failed: ${res.status} ${text}`);
      let description = `HTTP ${res.status}`;
      try {
        const body = JSON.parse(text) as { error?: { description?: string } };
        if (body.error?.description) description = body.error.description;
      } catch {
        /* non-JSON error body — keep the status line */
      }
      throw new Error(`Razorpay ${op} failed: ${description}`);
    }
    return JSON.parse(text) as T;
  }

  private keyId(): string {
    return this.config.get<string>('RAZORPAY_KEY_ID', '');
  }
  private keySecret(): string {
    return this.config.get<string>('RAZORPAY_KEY_SECRET', '');
  }
  private webhookSecret(): string {
    return this.config.get<string>('RAZORPAY_WEBHOOK_SECRET', '');
  }
  private authHeader(): string {
    const token = Buffer.from(`${this.keyId()}:${this.keySecret()}`).toString('base64');
    return `Basic ${token}`;
  }

  async createOrder(amountPaise: number, receipt: string): Promise<RpOrder> {
    const res = await fetch(`${this.base}/orders`, {
      method: 'POST',
      headers: { authorization: this.authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt }),
    });
    const data = await this.parse<{ id: string; amount: number }>(res, 'createOrder');
    return { orderId: data.id, amount: data.amount };
  }

  async fetchPayment(paymentId: string): Promise<RpPayment> {
    const res = await fetch(`${this.base}/payments/${paymentId}`, {
      headers: { authorization: this.authHeader() },
    });
    const d = await this.parse<{
      id: string;
      order_id: string;
      status: string;
      amount: number;
    }>(res, 'fetchPayment');
    return { id: d.id, orderId: d.order_id, status: d.status, amount: d.amount };
  }

  async refund(paymentId: string, amountPaise?: number): Promise<RpRefund> {
    const res = await fetch(`${this.base}/payments/${paymentId}/refund`, {
      method: 'POST',
      headers: { authorization: this.authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify(amountPaise ? { amount: amountPaise } : {}),
    });
    const d = await this.parse<{ id: string; status: string }>(res, 'refund');
    return { refundId: d.id, status: d.status };
  }

  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    return hmacEquals(this.keySecret(), `${orderId}|${paymentId}`, signature);
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    return hmacEquals(this.webhookSecret(), rawBody, signature);
  }
}

/**
 * Dev/CI fake — used when RAZORPAY_KEY_ID is absent, so local booking works
 * end-to-end without live keys (same dev-fallback philosophy as SMS_SENDER /
 * PUSH_SENDER). NOT for production: signatures are accepted unconditionally.
 *
 * The client mock (`payment.ts`, MOCK_PAYMENT) returns paymentId = `pay_dev_<orderId>`,
 * so `fetchPayment` can recover the order id and `confirm()`'s order-match check
 * passes without any real gateway round-trip.
 */
@Injectable()
export class FakeRazorpayGateway implements RazorpayGateway {
  async createOrder(amountPaise: number, receipt: string): Promise<RpOrder> {
    return { orderId: `order_dev_${receipt}`, amount: amountPaise };
  }

  async fetchPayment(paymentId: string): Promise<RpPayment> {
    const orderId = paymentId.startsWith('pay_dev_') ? paymentId.slice('pay_dev_'.length) : paymentId;
    return { id: paymentId, orderId, status: 'captured', amount: 0 };
  }

  /**
   * Dev refund. Real Razorpay returns a refund whose status settles to
   * `processed`, `pending`, or `failed`; the fake simulates the same three so
   * local/dev exercises every branch. Status is derived from a marker in the
   * payment id (`_rpend` -> pending, `_rfail` -> failed), defaulting to
   * `processed` — deterministic, so a given booking always behaves the same.
   */
  async refund(paymentId: string): Promise<RpRefund> {
    let status = 'processed';
    if (paymentId.includes('_rpend')) status = 'pending';
    else if (paymentId.includes('_rfail')) status = 'failed';
    return { refundId: `rfnd_dev_${paymentId}`, status };
  }

  verifyCheckoutSignature(): boolean {
    return true;
  }

  verifyWebhookSignature(): boolean {
    return true;
  }
}
