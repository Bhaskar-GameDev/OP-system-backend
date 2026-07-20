import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const SMS_SENDER = Symbol('SMS_SENDER');

/** Sends an OTP SMS. Swap the impl (real MSG91 vs test fake) via the SMS_SENDER token. */
export interface SmsSender {
  sendOtp(mobile: string, otp: string): Promise<void>;
}

/**
 * MSG91 OTP sender. If creds are absent (local/dev) it logs instead of calling
 * out, so the flow stays testable without a live provider. Wire the real HTTP
 * call here when creds exist.
 */
@Injectable()
export class Msg91SmsSender implements SmsSender {
  private readonly logger = new Logger(Msg91SmsSender.name);

  constructor(private readonly config: ConfigService) {}

  async sendOtp(mobile: string, otp: string): Promise<void> {
    const authKey = this.config.get<string>('MSG91_AUTH_KEY');
    if (!authKey) {
      this.logger.warn(`[DEV] OTP for ${mobile}: ${otp}`);
      return;
    }

    const templateId = this.config.get<string>('MSG91_OTP_TEMPLATE_ID');
    const senderId = this.config.get<string>('MSG91_SENDER_ID');
    const recipient = this.normalizeMobile(mobile);

    // MSG91 v5 OTP API — we pass our own OTP value so it matches what we store.
    const url = new URL('https://control.msg91.com/api/v5/otp');
    url.searchParams.set('otp', otp);
    url.searchParams.set('mobile', recipient);
    if (templateId) url.searchParams.set('template_id', templateId);
    if (senderId) url.searchParams.set('sender', senderId);

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method: 'POST',
        headers: { authkey: authKey, accept: 'application/json' },
      });
    } catch (err) {
      this.logger.error(`MSG91 request failed for ${recipient}: ${(err as Error).message}`);
      throw err;
    }

    const bodyText = await res.text();
    // MSG91 returns 200 with { type: 'success' | 'error', message } — a 200 alone
    // is not proof of delivery, so inspect the payload too.
    let type: string | undefined;
    try {
      type = (JSON.parse(bodyText) as { type?: string }).type;
    } catch {
      /* non-JSON body — fall through to status check */
    }
    if (!res.ok || type === 'error') {
      this.logger.error(`MSG91 rejected OTP for ${recipient}: ${res.status} ${bodyText}`);
      throw new Error(`MSG91 send failed: ${res.status}`);
    }

    this.logger.log(`OTP dispatched to ${recipient} via MSG91`);
  }

  /** Strip formatting and ensure a country code (defaults to India 91). */
  private normalizeMobile(mobile: string): string {
    const digits = mobile.replace(/\D/g, '');
    return digits.length === 10 ? `91${digits}` : digits;
  }
}
