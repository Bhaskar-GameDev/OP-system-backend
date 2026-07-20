import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PaymentsService } from './payments.service';

/**
 * Safety-net sweep for abandoned/failed payments. The payment.failed webhook is
 * the primary path; this catches the cases it misses (webhook dropped, patient
 * closed the app mid-checkout). Runs every 15 minutes and expires any booking
 * left in PENDING_PAYMENT for more than 30 minutes — releasing its token and
 * notifying the patient via the shared PaymentsService logic.
 *
 * Decoupled scheduled task (same pattern as ArchivalService) — no cleanup logic
 * is inlined into the payment handlers.
 */
@Injectable()
export class PaymentCleanupService {
  private readonly logger = new Logger(PaymentCleanupService.name);
  private static readonly STALE_MINUTES = 30;

  constructor(private readonly payments: PaymentsService) {}

  // every 15 minutes, on the quarter hour
  @Cron('0 */15 * * * *')
  async sweep(): Promise<void> {
    // The sweep is global (all clinics). Skip the scheduled trigger under tests
    // so it never fires mid-spec and mutates shared fixtures; the logic itself is
    // covered by calling expireStalePending directly. JEST_WORKER_ID is always
    // set under Jest regardless of NODE_ENV.
    if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined) {
      return;
    }
    try {
      const { expired } = await this.payments.expireStalePending(
        PaymentCleanupService.STALE_MINUTES,
      );
      if (expired > 0) {
        this.logger.log(`pending-payment sweep expired ${expired} booking(s)`);
      }
    } catch (err) {
      // a failed sweep must not crash the scheduler — next run retries
      this.logger.error(`pending-payment sweep failed: ${(err as Error).message}`);
    }
  }
}
