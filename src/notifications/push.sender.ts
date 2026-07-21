import { readFileSync } from 'node:fs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const PUSH_SENDER = Symbol('PUSH_SENDER');

/** Minimal shape of the firebase-admin pieces we touch (dep is lazy-loaded). */
type FirebaseAdmin = {
  apps: unknown[];
  initializeApp(opts: { credential: unknown }): unknown;
  credential: { cert(serviceAccount: Record<string, unknown>): unknown };
  messaging(): FirebaseMessaging;
};

/** The FCM message shape we build. `apns` is only set for iOS targets. */
export interface FcmMessage {
  token: string;
  notification: { title: string; body: string };
  data: Record<string, string>;
  apns?: {
    payload: { aps: { sound: string; badge: number } };
  };
}

type FirebaseMessaging = {
  send(msg: FcmMessage): Promise<string>;
};

/** A push notification payload destined for one device token. */
export interface PushMessage {
  title: string;
  body: string;
  data: Record<string, string>; // structured payload (type, token, bookingId, ...)
}

/**
 * Platform a device token belongs to. Null means the token was registered
 * before the platform column existed, which can only be Android.
 */
export type DevicePlatform = 'ANDROID' | 'IOS' | null;

/**
 * Build the FCM message for one device.
 *
 * FCM delivers to iOS via APNs on our behalf, but only if the message carries an
 * `apns` block — without it the notification still arrives, silently and with no
 * badge, which reads as "push is broken" to a patient waiting on their token.
 * Android needs no equivalent: its sound/priority come from the notification
 * channel the app registers, not from the message.
 *
 * Exported so the platform branch is unit-testable without a live FCM client.
 */
export function buildFcmMessage(
  deviceToken: string,
  message: PushMessage,
  platform: DevicePlatform,
): FcmMessage {
  const base: FcmMessage = {
    token: deviceToken,
    notification: { title: message.title, body: message.body },
    data: message.data,
  };
  if (platform !== 'IOS') return base;

  return {
    ...base,
    apns: {
      // Static badge of 1: this is a "you have something waiting" nudge, not an
      // unread counter — the backend tracks no per-patient unread state.
      payload: { aps: { sound: 'default', badge: 1 } },
    },
  };
}

/**
 * Sends a push to one FCM device token. Swap the impl (real FCM vs test fake)
 * via the PUSH_SENDER token — same seam pattern as SMS_SENDER / RAZORPAY_GATEWAY.
 */
export interface PushSender {
  send(
    deviceToken: string,
    message: PushMessage,
    platform?: DevicePlatform,
  ): Promise<void>;
}

/**
 * Firebase Cloud Messaging sender. If creds are absent (local/dev/CI) it logs
 * instead of calling out, so the flow stays testable without live Firebase.
 * Wire the firebase-admin SDK send here when a service account is configured.
 */
@Injectable()
export class FcmPushSender implements PushSender {
  private readonly logger = new Logger(FcmPushSender.name);
  private messaging?: FirebaseMessaging;
  private initFailed = false;

  constructor(private readonly config: ConfigService) {}

  async send(
    deviceToken: string,
    message: PushMessage,
    platform: DevicePlatform = null,
  ): Promise<void> {
    const messaging = await this.getMessaging();
    if (!messaging) {
      this.logger.warn(
        `FCM not configured; would push "${message.title}" to ${deviceToken.slice(0, 8)}…`,
      );
      return;
    }

    try {
      await messaging.send(buildFcmMessage(deviceToken, message, platform));
    } catch (err) {
      this.logger.error(
        `FCM send failed for ${deviceToken.slice(0, 8)}…: ${(err as Error).message}`,
      );
      throw err;
    }
    this.logger.log(`Push "${message.title}" dispatched to ${deviceToken.slice(0, 8)}… via FCM`);
  }

  /**
   * Lazily resolve the firebase-admin messaging client. Returns undefined when
   * no service account is configured (dev/CI) or the optional dep is absent, so
   * the caller falls back to a log instead of throwing.
   */
  private async getMessaging() {
    if (this.messaging) return this.messaging;
    if (this.initFailed) return undefined;

    const serviceAccount = this.loadServiceAccount();
    if (!serviceAccount) {
      this.initFailed = true;
      return undefined;
    }

    let admin: FirebaseAdmin;
    try {
      // Non-literal specifier: keeps the optional dep out of the compiler's
      // static resolution so the build passes before `npm install firebase-admin`.
      const moduleName = 'firebase-admin';
      admin = (await import(moduleName)) as unknown as FirebaseAdmin;
    } catch {
      this.logger.error('firebase-admin not installed; run `npm install firebase-admin`');
      this.initFailed = true;
      return undefined;
    }

    if (admin.apps.length === 0) {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    this.messaging = admin.messaging();
    return this.messaging;
  }

  /** Service account from inline JSON env, else a file path. Null when neither set. */
  private loadServiceAccount(): Record<string, unknown> | null {
    const inline = this.config.get<string>('FCM_SERVICE_ACCOUNT_JSON');
    if (inline) {
      try {
        return JSON.parse(inline) as Record<string, unknown>;
      } catch (err) {
        this.logger.error(`FCM_SERVICE_ACCOUNT_JSON is not valid JSON: ${(err as Error).message}`);
        return null;
      }
    }

    const path = this.config.get<string>('FCM_SERVICE_ACCOUNT_PATH');
    if (path) {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      } catch (err) {
        this.logger.error(`Cannot read FCM service account at ${path}: ${(err as Error).message}`);
        return null;
      }
    }
    return null;
  }
}
