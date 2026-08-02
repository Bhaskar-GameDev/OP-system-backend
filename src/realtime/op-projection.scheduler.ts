import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
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
export class OpProjectionScheduler implements OnModuleDestroy {
  private readonly logger = new Logger(OpProjectionScheduler.name);
  /** The drain currently in progress, or null when idle. */
  private inFlight: Promise<void> | null = null;
  /** Set on shutdown: no new passes, and the current one is awaited out. */
  private stopped = false;

  constructor(
    private readonly runner: ProjectionRunner,
    private readonly gateway: QueueGateway,
  ) {}

  /**
   * Stop projecting on shutdown and WAIT for any pass already running.
   *
   * Without this, `app.close()` could return while a drain was still writing
   * read models and advancing the shared projection cursor. In production that
   * is a half-finished projection racing the shutdown; across a test suite it is
   * worse — a closed app's straggling pass consumes events belonging to the NEXT
   * spec, which then finds its own read models empty. That was the intermittent
   * red that kept moving between read-side / op-e2e / notifications.
   */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.inFlight) await this.inFlight.catch(() => undefined);
  }

  /**
   * The scheduled tick. SKIPS when a drain is already running — a long drain
   * must not have another stacked on top of it. The next tick resumes from the
   * persisted cursor, so skipping loses nothing.
   */
  @Interval('op-projection', TICK_MS)
  async tick(): Promise<void> {
    if (this.stopped || this.inFlight) return;
    await this.run();
  }

  /**
   * Project everything appended so far and WAIT for it — unlike {@link tick},
   * which silently returns when it collides with an in-flight drain.
   *
   * That distinction matters for tests: `await tick()` looks like "drain now"
   * but, whenever it happened to land while the 2s background tick was mid-run,
   * it did nothing and the test read a stale read model. That is exactly the
   * intermittent cross-suite red that moved between read-side / op-e2e /
   * notifications. Use this whenever you need the projection to be caught up
   * before asserting.
   */
  async drain(): Promise<void> {
    // Wait out a drain that started before us — it may not have seen our events.
    if (this.inFlight) await this.inFlight.catch(() => undefined);
    await this.run();
  }

  /** One projection pass, tracked so concurrent callers can await it. */
  private async run(): Promise<void> {
    if (this.stopped) return;
    const pass = (async () => {
      try {
        const applied = await this.runner.runOnce();
        if (applied > 0) await this.gateway.refreshActiveOpRooms();
      } catch (err) {
        this.logger.warn(`op projection tick failed: ${String(err)}`);
      }
    })();
    this.inFlight = pass;
    try {
      await pass;
    } finally {
      this.inFlight = null;
    }
  }
}
