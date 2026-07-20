import { Module } from '@nestjs/common';
import { TokenService } from './token.service';
import { QueueService } from './queue.service';
import { EtaService } from './eta.service';
import { ConsultationService } from './consultation.service';
import { QueueEventsService } from './queue-events.service';
import { QueueGateway } from './queue.gateway';
import { QueueEngineController } from './queue-engine.controller';
import { QueueStatusController } from './queue-status.controller';
import { AuditLogController } from './audit-log.controller';
import { AuditService } from './audit.service';

@Module({
  controllers: [QueueEngineController, QueueStatusController, AuditLogController],
  providers: [
    TokenService,
    QueueService,
    EtaService,
    ConsultationService,
    QueueEventsService,
    QueueGateway,
    AuditService,
  ],
  exports: [
    TokenService,
    QueueService,
    EtaService,
    ConsultationService,
    QueueEventsService,
    AuditService,
  ],
})
export class QueueEngineModule {}
