import { Module } from '@nestjs/common';
import { QueueEngineModule } from '../queue-engine/queue-engine.module';
import { OpMirrorModule } from '../op-mirror/op-mirror.module';
import { CheckInModule } from '../check-in/checkin.module';
import { OpPaymentsModule } from '../op-payments/op-payments.module';
import { OpQueueModule } from '../queue/op-queue.module';
import { ReceptionService } from './reception.service';
import { ReceptionController } from './reception.controller';
import { LegacyRosterCompatService } from './legacy-roster-compat.service';

// Reception desk — check-in (Arrived/Not Arrived) + walk-in registration.
// Walk-ins reuse the Queue Engine's enqueueBooking (atomic token + enqueue).
@Module({
  imports: [QueueEngineModule, OpMirrorModule, CheckInModule, OpPaymentsModule, OpQueueModule],
  controllers: [ReceptionController],
  providers: [ReceptionService, LegacyRosterCompatService],
})
export class ReceptionModule {}
