import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ProjectionRunner } from '../read-side/projection-runner.service';
import { QueueGateway } from '../queue-engine/queue.gateway';

const TICK_MS = 2000;

/**
 * Live projection tick (Task 3). Every couple of seconds it drains new domain
 * events into the CQRS read models (ProjectionRunner.runOnce — idempotent +
 * resumable) and, when anything was applied, re-pushes the fresh read-model state
 * to whoever is watching over the socket gateway. This is what makes the doctor /
 * reception / patient views update in real time off the new engine.
 *
 * A single non-reentrant guard prevents overlapping ticks if a drain runs long;
 * failures are logged and swallowed so a transient DB blip never crashes the
 * scheduler (the next tick simply resumes from the persisted cursor).
 */
@Injectable()
export class OpProjectionScheduler {
  private readonly logger = new Logger(OpProjectionScheduler.name);
  private running = false;

  constructor(
    private readonly runner: ProjectionRunner,
    private readonly gateway: QueueGateway,
  ) {}

  @Interval('op-projection', TICK_MS)
  async tick(): Promise<void> {
    if (this.running) return; // never overlap a still-running drain
    this.running = true;
    try {
      const applied = await this.runner.runOnce();
      if (applied > 0) await this.gateway.refreshActiveOpRooms();
    } catch (err) {
      this.logger.warn(`op projection tick failed: ${String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
