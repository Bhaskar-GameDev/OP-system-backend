import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const PUSH_SENDER = Symbol('PUSH_SENDER');

/** A push notification payload destined for one device token. */
export interface PushMessage {
  title: string;
  body: string;
  data: Record<string, string>; // structured payload (type, token, bookingId, ...)
}

/**
 * Sends a push to one FCM device token. Swap the impl (real FCM vs test fake)
 * via the PUSH_SENDER token — same seam pattern as SMS_SENDER / RAZORPAY_GATEWAY.
 */
export interface PushSender {
  send(deviceToken: string, message: PushMessage): Promise<void>;
}

/**
 * Firebase Cloud Messaging sender. If creds are absent (local/dev/CI) it logs
 * instead of calling out, so the flow stays testable without live Firebase.
 * Wire the firebase-admin SDK send here when a service account is configured.
 */
@Injectable()
export class FcmPushSender implements PushSender {
  private readonly logger = new Logger(FcmPushSender.name);

  constructor(private readonly config: ConfigService) {}

  async send(deviceToken: string, message: PushMessage): Promise<void> {
    const projectId = this.config.get<string>('FCM_PROJECT_ID');
    if (!projectId) {
      this.logger.warn(
        `FCM not configured; would push "${message.title}" to ${deviceToken.slice(0, 8)}…`,
      );
      return;
    }
    // TODO: real firebase-admin messaging().send({ token, notification, data }).
    this.logger.log(`Push "${message.title}" dispatched to ${deviceToken.slice(0, 8)}… via FCM`);
  }
}
