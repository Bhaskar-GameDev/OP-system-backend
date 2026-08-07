import { Module } from '@nestjs/common';
import { QueueEngineModule } from '../queue-engine/queue-engine.module';
import { ConsultationNotesModule } from '../consultation-notes/consultation-notes.module';
import { DoctorController } from './doctor.controller';
import { DoctorService } from './doctor.service';
import { OpQueueCompatService } from './op-queue-compat.service';

// Doctor Dashboard — read surface for a doctor's own live session. Reuses the
// Queue Engine (EtaService + QueueService) for ordering/ETA; mutations stay on
// the existing audited /queue/* routes. No queue logic is duplicated here.
// Consultation-note read/write reuses the shared ConsultationNotesService.
@Module({
  imports: [QueueEngineModule, ConsultationNotesModule],
  controllers: [DoctorController],
  providers: [DoctorService, OpQueueCompatService],
})
export class DoctorModule {}
