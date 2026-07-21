import { Module } from '@nestjs/common';
import { QueueEngineModule } from '../queue-engine/queue-engine.module';
import { DisplayController } from './display.controller';

/**
 * Public waiting-room board.
 *
 * Holds only the HTTP surface. DisplayService itself is provided by
 * QueueEngineModule because QueueGateway also needs it (to push sanitized card
 * updates), and putting it here would make the two modules import each other.
 */
@Module({
  imports: [QueueEngineModule],
  controllers: [DisplayController],
})
export class DisplayModule {}
