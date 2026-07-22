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
  RAZORPAY_GATEWAY,
} from './razorpay.gateway';

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
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        if (config.get<string>('RAZORPAY_KEY_ID')) {
          return new HttpRazorpayGateway(config);
        }
        new Logger('PaymentsModule').warn(
          'RAZORPAY_KEY_ID unset — using FakeRazorpayGateway (dev only, signatures not verified)',
        );
        return new FakeRazorpayGateway();
      },
    },
  ],
  exports: [PaymentsService, RAZORPAY_GATEWAY],
})
export class PaymentsModule {}
