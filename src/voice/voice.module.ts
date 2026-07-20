import { Module } from '@nestjs/common';
import { QueueEngineModule } from '../queue-engine/queue-engine.module';
import { PaymentsModule } from '../payments/payments.module';
import { SessionResolverModule } from '../bookings/session-resolver.module';
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
  imports: [QueueEngineModule, PaymentsModule, SessionResolverModule],
  controllers: [VoiceController],
  providers: [VoiceService],
})
export class VoiceModule {}
