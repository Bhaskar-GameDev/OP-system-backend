import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
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

  constructor(private readonly config: ConfigService) {}

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
    const data = (await res.json()) as { id: string; amount: number };
    return { orderId: data.id, amount: data.amount };
  }

  async fetchPayment(paymentId: string): Promise<RpPayment> {
    const res = await fetch(`${this.base}/payments/${paymentId}`, {
      headers: { authorization: this.authHeader() },
    });
    const d = (await res.json()) as {
      id: string;
      order_id: string;
      status: string;
      amount: number;
    };
    return { id: d.id, orderId: d.order_id, status: d.status, amount: d.amount };
  }

  async refund(paymentId: string, amountPaise?: number): Promise<RpRefund> {
    const res = await fetch(`${this.base}/payments/${paymentId}/refund`, {
      method: 'POST',
      headers: { authorization: this.authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify(amountPaise ? { amount: amountPaise } : {}),
    });
    const d = (await res.json()) as { id: string; status: string };
    return { refundId: d.id, status: d.status };
  }

  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    return hmacEquals(this.keySecret(), `${orderId}|${paymentId}`, signature);
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    return hmacEquals(this.webhookSecret(), rawBody, signature);
  }
}
