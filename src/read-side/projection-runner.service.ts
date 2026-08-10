import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { EventStoreService } from '../event-store/event-store.service';
import { ProjectionService } from './projection.service';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { MetricsService } from '../common/observability/metrics.service';

const CURSOR = 'queue_read_model';

/**
 * Drives the read side off the event store (Phase 14). Pulls new events since the
 * persisted cursor, applies each to the projection AND dispatches notifications,
 * then advances the cursor. Idempotent + resumable: safe to run on a timer, and
 * `rebuild()` drops the read model and replays from zero (Phase 13).
 */
@Injectable()
export class ProjectionRunner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventStoreService,
    private readonly projection: ProjectionService,
    private readonly notifications: NotificationDispatcher,
    private readonly metrics: MetricsService,
  ) {}

  /** Process all events after the cursor. Returns how many were applied. */
  async runOnce(opts: { notify?: boolean } = { notify: true }): Promise<number> {
    const cursorRow = await this.prisma.projectionCursor.findUnique({
      where: { name: CURSOR },
    });
    let cursor = cursorRow?.globalSeq ?? 0n;
    let total = 0;

    // Drain in batches so a large backlog is bounded per query.
    for (;;) {
      const { events, cursor: next } = await this.events.replay(cursor, 500);
      if (events.length === 0) break;
      for (const e of events) {
        await this.projection.apply(e);
        if (opts.notify) await this.notifications.handle(e);
      }
      cursor = next;
      total += events.length;
      await this.prisma.projectionCursor.upsert({
        where: { name: CURSOR },
        create: { name: CURSOR, globalSeq: cursor },
        update: { globalSeq: cursor },
      });
      if (events.length < 500) break;
    }
    await this.recordLag(cursor);
    return total;
  }

  /**
   * Publish how far the read models trail the event store.
   *
   * A stalled projection is a silent failure: every endpoint still answers 200
   * while dashboards show the past, so nothing in the HTTP metrics moves. This
   * gauge is the only signal that distinguishes "quiet clinic" from "projection
   * stopped", which is why it is measured after every pass rather than sampled.
   */
  private async recordLag(cursor: bigint): Promise<void> {
    try {
      const latest = await this.prisma.domainEvent.findFirst({
        orderBy: { globalSeq: 'desc' },
        select: { globalSeq: true },
      });
      const head = latest?.globalSeq ?? 0n;
      this.metrics.projectionLag.set(Number(head > cursor ? head - cursor : 0n));
    } catch {
      // Measurement must never break projection: the lag gauge going stale is a
      // smaller problem than a read model that stops updating.
    }
  }

  /**
   * Rebuild the read model from scratch (Phase 13: event replay). Drops all rows,
   * resets the cursor, and re-applies the entire stream WITHOUT re-notifying.
   */
  async rebuild(): Promise<number> {
    await this.prisma.queueReadModel.deleteMany({});
    await this.prisma.projectionCursor.upsert({
      where: { name: CURSOR },
      create: { name: CURSOR, globalSeq: 0n },
      update: { globalSeq: 0n },
    });
    return this.runOnce({ notify: false });
  }
}
