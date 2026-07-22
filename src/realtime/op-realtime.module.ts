import { Module } from '@nestjs/common';
import { ReadSideModule } from '../read-side/read-side.module';
import { QueueEngineModule } from '../queue-engine/queue-engine.module';
import { OpProjectionScheduler } from './op-projection.scheduler';

/**
 * Realtime bridge for the new token engine (Task 3): a scheduled projection tick
 * that keeps the CQRS read models live and fans fresh state out over the existing
 * Socket.io gateway. Separate module so the timing/transport concern is isolated
 * from the pure read-side projector.
 */
@Module({
  imports: [ReadSideModule, QueueEngineModule],
  providers: [OpProjectionScheduler],
  exports: [OpProjectionScheduler],
})
export class OpRealtimeModule {}
