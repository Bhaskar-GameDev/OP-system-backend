import { Module } from '@nestjs/common';
import { EncountersModule } from '../encounters/encounters.module';
import { CheckInModule } from '../check-in/checkin.module';
import { OpQueueModule } from '../queue/op-queue.module';
import { OpMirrorService } from './op-mirror.service';

/**
 * Transitional dual-write bridge (Task 2). Wires the new Encounter pipeline into
 * the legacy channels (reception/voice/payments) without those channels taking a
 * dependency on the internals of the engine. Retired in Task 5 at read cutover.
 */
@Module({
  imports: [EncountersModule, CheckInModule, OpQueueModule],
  providers: [OpMirrorService],
  exports: [OpMirrorService],
})
export class OpMirrorModule {}
