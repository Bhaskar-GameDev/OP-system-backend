import { Module } from '@nestjs/common';
import { RedisModule } from '../common/redis/redis.module';
import { OpSessionService } from './op-session.service';
import { QueuePolicyService } from './queue-policy.service';
import { OpQueueService } from './op-queue.service';

/**
 * Token-based queue engine (Phases 5+6). Distinct from the legacy
 * queue-engine/ module (retired in Phase 15). Exports the engine + session +
 * policy services for the consultation engine (Phase 7) to drive.
 */
@Module({
  imports: [RedisModule],
  providers: [OpSessionService, QueuePolicyService, OpQueueService],
  exports: [OpSessionService, QueuePolicyService, OpQueueService],
})
export class OpQueueModule {}
