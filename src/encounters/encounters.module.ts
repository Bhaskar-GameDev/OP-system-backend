import { Module } from '@nestjs/common';
import { EncounterService } from './encounter.service';

/**
 * Registration pipeline (Phase 2). Exports EncounterService so channel modules
 * (reception, voice, app/bookings) all register through the ONE unified path.
 * PrismaModule, EventStoreModule, StateMachineModule are global.
 */
@Module({
  providers: [EncounterService],
  exports: [EncounterService],
})
export class EncountersModule {}
