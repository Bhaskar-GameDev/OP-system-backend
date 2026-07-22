import { Module } from '@nestjs/common';
import { EncountersModule } from '../encounters/encounters.module';
import { OpQueueModule } from '../queue/op-queue.module';
import { DoctorOverrideService } from './doctor-override.service';
import { EmergencyService } from './emergency.service';

/**
 * Doctor Override (Phase 8) + Emergency interruption (Phase 9). Both are room
 * workflows that bypass the queue by design; neither renumbers waiting tokens.
 */
@Module({
  imports: [EncountersModule, OpQueueModule],
  providers: [DoctorOverrideService, EmergencyService],
  exports: [DoctorOverrideService, EmergencyService],
})
export class OverrideModule {}
