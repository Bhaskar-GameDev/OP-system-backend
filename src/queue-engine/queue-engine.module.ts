import { Module } from '@nestjs/common';
import { SessionResolverModule } from '../bookings/session-resolver.module';
import { ReadSideModule } from '../read-side/read-side.module';
import { DisplayService } from '../display/display.service';
import { TokenService } from './token.service';
import { QueueService } from './queue.service';
import { EtaService } from './eta.service';
import { ConsultationService } from './consultation.service';
import { QueueEventsService } from './queue-events.service';
import { QueueGateway } from './queue.gateway';
import { PatientStatusCompatService } from './patient-status-compat.service';
import { QueueEngineController } from './queue-engine.controller';
import { QueueStatusController } from './queue-status.controller';
import { AuditLogController } from './audit-log.controller';
import { AuditService } from './audit.service';

@Module({
  imports: [SessionResolverModule, ReadSideModule],
  controllers: [QueueEngineController, QueueStatusController, AuditLogController],
  providers: [
    TokenService,
    QueueService,
    EtaService,
    ConsultationService,
    QueueEventsService,
    QueueGateway,
    AuditService,
    DisplayService,
    PatientStatusCompatService,
  ],
  exports: [
    TokenService,
    QueueService,
    EtaService,
    ConsultationService,
    QueueEventsService,
    AuditService,
    DisplayService,
    QueueGateway,
  ],
})
export class QueueEngineModule {}
