import { Module } from '@nestjs/common';
import { OpQueueModule } from '../queue/op-queue.module';
import { EncountersModule } from '../encounters/encounters.module';
import { CheckInModule } from '../check-in/checkin.module';
import { TokensModule } from '../tokens/tokens.module';
import { ConsultationEngineService } from './consultation-engine.service';

/**
 * Consultation engine (Phase 7). Drives the queue engine (Call Next) and the
 * in-room state machine (start/complete/pause/resume), plus skip/recall/no-show/
 * transfer. Depends on registration + check-in + token modules for transfer.
 */
@Module({
  imports: [OpQueueModule, EncountersModule, CheckInModule, TokensModule],
  providers: [ConsultationEngineService],
  exports: [ConsultationEngineService],
})
export class ConsultationModule {}
