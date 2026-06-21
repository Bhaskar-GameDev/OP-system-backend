import { Module } from '@nestjs/common';
import { QueueEngineModule } from '../queue-engine/queue-engine.module';
import { ReceptionService } from './reception.service';
import { ReceptionController } from './reception.controller';

// Reception desk — check-in (Arrived/Not Arrived) + walk-in registration.
// Walk-ins reuse the Queue Engine's enqueueBooking (atomic token + enqueue).
@Module({
  imports: [QueueEngineModule],
  controllers: [ReceptionController],
  providers: [ReceptionService],
})
export class ReceptionModule {}
