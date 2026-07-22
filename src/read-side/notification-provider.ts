import { Logger } from '@nestjs/common';

/** Notification channels a provider may serve. */
export type NotificationChannel = 'PUSH' | 'SMS' | 'IN_APP';

/** A rendered notification ready to deliver. */
export interface OutboundNotification {
  channel: NotificationChannel;
  to: string; // device token / mobile / patient id, per channel
  templateKey: string; // e.g. "token_generated"
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/**
 * Pluggable delivery provider (ARCHITECTURE.md §11, §12.8, Phase 10). Providers
 * are swappable behind this port — FCM, MSG91, in-app, or a test double — with no
 * change to the dispatcher. Multiple providers may be registered; each declares
 * the channels it handles.
 */
export interface NotificationProvider {
  readonly channels: NotificationChannel[];
  send(n: OutboundNotification): Promise<void>;
}

/** DI token for the provider list. */
export const NOTIFICATION_PROVIDERS = Symbol('NOTIFICATION_PROVIDERS');

/**
 * Default dev provider: logs instead of delivering (mirrors the existing
 * dev-fallback posture — OTP/push logged, not sent). Handles every channel so a
 * fresh deployment never drops a notification on the floor.
 */
export class LogNotificationProvider implements NotificationProvider {
  private readonly logger = new Logger('Notify');
  readonly channels: NotificationChannel[] = ['PUSH', 'SMS', 'IN_APP'];
  async send(n: OutboundNotification): Promise<void> {
    this.logger.log(`[${n.channel}] -> ${n.to}: ${n.title} — ${n.body}`);
  }
}
