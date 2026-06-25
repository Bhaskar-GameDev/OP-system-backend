import { Module } from '@nestjs/common';
import { QueueEngineModule } from '../queue-engine/queue-engine.module';
import { VoiceController } from './voice.controller';
import { VoiceService } from './voice.service';

/**
 * Internal API for the standalone voice agent. Reuses the Queue Engine's atomic
 * token+enqueue primitives (ConsultationService / QueueService) so a VOICE
 * booking goes through the exact same path as an app or walk-in booking.
 * PrismaModule / ConfigModule are global.
 */
@Module({
  imports: [QueueEngineModule],
  controllers: [VoiceController],
  providers: [VoiceService],
})
export class VoiceModule {}
