import { Module } from '@nestjs/common';
import {
  LogNotificationProvider,
  NOTIFICATION_PROVIDERS,
} from './notification-provider';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { ProjectionService } from './projection.service';
import { ProjectionRunner } from './projection-runner.service';
import { QueueReadService } from './queue-read.service';
import { ObservabilityModule } from '../common/observability/observability.module';

/**
 * CQRS read side (Phases 10+14): projector + read models + notification pipeline.
 * Providers are injected as a list so real providers (FCM/MSG91) or a test double
 * can replace the default LogNotificationProvider with no dispatcher change.
 */
@Module({
  // ObservabilityModule is @Global under AppModule, but imported explicitly so
  // the partial test modules that assemble the read side on its own still
  // resolve MetricsService (the projection publishes its lag from here).
  imports: [ObservabilityModule],
  providers: [
    {
      provide: NOTIFICATION_PROVIDERS,
      useFactory: () => [new LogNotificationProvider()],
    },
    NotificationDispatcher,
    ProjectionService,
    ProjectionRunner,
    QueueReadService,
  ],
  exports: [ProjectionRunner, QueueReadService, NotificationDispatcher],
})
export class ReadSideModule {}
