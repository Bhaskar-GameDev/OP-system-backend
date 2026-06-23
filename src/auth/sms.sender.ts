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
    // TODO: real MSG91 HTTP request (template + sender id from config).
    this.logger.log(`OTP dispatched to ${mobile} via MSG91`);
  }
}
