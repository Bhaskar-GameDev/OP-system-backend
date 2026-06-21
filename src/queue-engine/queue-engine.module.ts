import { Module } from '@nestjs/common';
import { TokenService } from './token.service';
import { QueueService } from './queue.service';
import { EtaService } from './eta.service';
import { ConsultationService } from './consultation.service';
import { QueueEventsService } from './queue-events.service';
import { QueueGateway } from './queue.gateway';
import { QueueEngineController } from './queue-engine.controller';

@Module({
  controllers: [QueueEngineController],
  providers: [
    TokenService,
    QueueService,
    EtaService,
    ConsultationService,
    QueueEventsService,
    QueueGateway,
  ],
  exports: [
    TokenService,
    QueueService,
    EtaService,
    ConsultationService,
    QueueEventsService,
  ],
})
export class QueueEngineModule {}
