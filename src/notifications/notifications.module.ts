import { Module } from '@nestjs/common';
import { QueueEngineModule } from '../queue-engine/queue-engine.module';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { FcmPushSender, PUSH_SENDER } from './push.sender';

// Step 6 — Notifications (FCM). A second consumer of the Queue Engine's
// session-changed stream; no triggers added into the mutation handlers.
@Module({
  imports: [QueueEngineModule], // QueueService + QueueEventsService
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    { provide: PUSH_SENDER, useClass: FcmPushSender },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
