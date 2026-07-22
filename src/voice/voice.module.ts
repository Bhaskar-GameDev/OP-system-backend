import { Module } from '@nestjs/common';
import { QueueEngineModule } from '../queue-engine/queue-engine.module';
import { PaymentsModule } from '../payments/payments.module';
import { SessionResolverModule } from '../bookings/session-resolver.module';
import { OpMirrorModule } from '../op-mirror/op-mirror.module';
import { Msg91SmsSender, SMS_SENDER } from '../auth/sms.sender';
import { VoiceController } from './voice.controller';
import { VoiceService } from './voice.service';

/**
 * Voice API. Reuses the existing engines rather than re-implementing booking:
 *  - QueueEngineModule -> ConsultationService, QueueService, AuditService
 *  - PaymentsModule    -> PaymentsService (cancel/refund primitive)
 *  - SessionResolverModule -> same-day session resolution
 * (PrismaModule is global.)
 */
@Module({
  imports: [QueueEngineModule, PaymentsModule, SessionResolverModule, OpMirrorModule],
  controllers: [VoiceController],
  // SMS_SENDER is provided locally (same as AuthModule / IntegrationsModule do)
  // rather than exported from AuthModule — the booking confirmation SMS is the
  // caller's only record of their token, so this module owns that dependency.
  providers: [VoiceService, { provide: SMS_SENDER, useClass: Msg91SmsSender }],
})
export class VoiceModule {}
