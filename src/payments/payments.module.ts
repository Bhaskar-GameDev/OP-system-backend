import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueueEngineModule } from '../queue-engine/queue-engine.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SessionResolverModule } from '../bookings/session-resolver.module';
import { OpMirrorModule } from '../op-mirror/op-mirror.module';
import { PaymentsService } from './payments.service';
import { PaymentCleanupService } from './payment-cleanup.service';
import { PaymentsController } from './payments.controller';
import {
  FakeRazorpayGateway,
  HttpRazorpayGateway,
  RazorpayGateway,
  RAZORPAY_GATEWAY,
} from './razorpay.gateway';
import { isProduction } from '../common/config/production-config.validator';
import { MetricsService } from '../common/observability/metrics.service';

/**
 * Gateway selection. Exported so the rule is directly testable rather than
 * buried in a module factory.
 *
 * PRODUCTION: always the real gateway. There is no branch to the fake — the
 * fake accepts any signature, so "no keys configured" must be a startup failure
 * (raised by HttpRazorpayGateway's own constructor), never a silent downgrade
 * to unverified payments. This was CRITICAL finding #3.
 *
 * DEVELOPMENT/TEST: the fake when no key id is set, so local booking works
 * end-to-end without live Razorpay credentials.
 */
export function selectRazorpayGateway(
  config: ConfigService,
  metrics?: MetricsService,
): RazorpayGateway {
  if (isProduction()) {
    return new HttpRazorpayGateway(config, metrics);
  }
  if ((config.get<string>('RAZORPAY_KEY_ID') ?? '').trim()) {
    return new HttpRazorpayGateway(config, metrics);
  }
  new Logger('PaymentsModule').warn(
    'RAZORPAY_KEY_ID unset — using FakeRazorpayGateway (development only; signatures are NOT verified)',
  );
  return new FakeRazorpayGateway();
}

// Step 5 — Payments (Razorpay). Token issued ONLY inside the confirmed,
// idempotent handler, reusing the Queue Engine's enqueueBooking.
@Module({
  imports: [QueueEngineModule, NotificationsModule, SessionResolverModule, OpMirrorModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    PaymentCleanupService,
    {
      // Real gateway when keys are configured; dev fake otherwise so local
      // booking works end-to-end without live Razorpay credentials.
      provide: RAZORPAY_GATEWAY,
      inject: [ConfigService, MetricsService],
      useFactory: (config: ConfigService, metrics: MetricsService) =>
        selectRazorpayGateway(config, metrics),
    },
  ],
  exports: [PaymentsService, RAZORPAY_GATEWAY],
})
export class PaymentsModule {}
