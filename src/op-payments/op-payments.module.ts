import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { OpPaymentService } from './op-payment.service';
import { OpPaymentController } from './op-payment.controller';

/**
 * Decoupled OP payments (Task 4). Reuses the shared RAZORPAY_GATEWAY (exported by
 * PaymentsModule) for online orders; PrismaService, EventStoreService and
 * TenantService are global. Kept separate from OpHttpModule because its auth is
 * mixed-audience (patient + staff), not the staff-only TenantScopeGuard surface.
 */
@Module({
  imports: [AuthModule, PaymentsModule],
  providers: [OpPaymentService],
  controllers: [OpPaymentController],
  exports: [OpPaymentService],
})
export class OpPaymentsModule {}
