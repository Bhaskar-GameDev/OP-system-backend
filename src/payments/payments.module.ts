import { Module } from '@nestjs/common';
import { QueueEngineModule } from '../queue-engine/queue-engine.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { HttpRazorpayGateway, RAZORPAY_GATEWAY } from './razorpay.gateway';

// Step 5 — Payments (Razorpay). Token issued ONLY inside the confirmed,
// idempotent handler, reusing the Queue Engine's enqueueBooking.
@Module({
  imports: [QueueEngineModule, NotificationsModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    { provide: RAZORPAY_GATEWAY, useClass: HttpRazorpayGateway },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
