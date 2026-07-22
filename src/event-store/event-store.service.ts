import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  EventInput,
  EventMetadata,
  StoredEvent,
  StreamType,
} from './domain-event.types';

/**
 * Append-only event store (ARCHITECTURE.md §12.1, Phase 13).
 *
 * Correctness rules:
 *  - Per-stream versions are contiguous and monotonic (1,2,3,…). The unique
 *    index (stream_type, stream_id, version) makes a duplicate version a hard
 *    DB error — two concurrent writers can never both claim version N.
 *  - Optimistic concurrency: a caller passes the version it BELIEVES is current;
 *    if another writer advanced the stream first, the append fails with 409 and
 *    the caller re-reads and retries. No lost updates.
 *  - `globalSeq` (DB autoincrement) gives a total order across all streams for
 *    deterministic replay.
 */
@Injectable()
export class EventStoreService {
  constructor(private readonly prisma: PrismaService) {}

  /** Highest version currently stored for a stream (0 if the stream is new). */
  async currentVersion(
    streamType: StreamType,
    streamId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<number> {
    const last = await tx.domainEvent.findFirst({
      where: { streamType, streamId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    return last?.version ?? 0;
  }

  /**
   * Append one event with optimistic concurrency.
   *
   * @param expectedVersion the version the caller last saw. The event is written
   *   at expectedVersion + 1. If that slot is taken (someone else appended),
   *   throws ConflictException — the caller reloads and retries.
   */
  async append(
    input: EventInput,
    expectedVersion: number,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<StoredEvent> {
    const version = expectedVersion + 1;
    try {
      const row = await tx.domainEvent.create({
        data: {
          streamType: input.streamType,
          streamId: input.streamId,
          version,
          type: input.type,
          payload: input.payload as Prisma.InputJsonValue,
          metadata: (input.metadata ?? undefined) as
            | Prisma.InputJsonValue
            | undefined,
        },
      });
      return this.toStored(row);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          `Concurrent write on ${input.streamType}:${input.streamId} at version ${version}`,
        );
      }
      throw e;
    }
  }

  /**
   * Append several events to ONE stream atomically, versions auto-assigned from
   * the current head. Use for a command that emits multiple events at once.
   * The whole batch shares a transaction: all land or none do.
   */
  async appendMany(
    streamType: StreamType,
    streamId: string,
    events: Omit<EventInput, 'streamType' | 'streamId'>[],
    expectedVersion: number,
    tx?: Prisma.TransactionClient,
  ): Promise<StoredEvent[]> {
    const run = async (t: Prisma.TransactionClient): Promise<StoredEvent[]> => {
      const out: StoredEvent[] = [];
      let v = expectedVersion;
      for (const e of events) {
        const stored = await this.append(
          { ...e, streamType, streamId },
          v,
          t,
        );
        out.push(stored);
        v = stored.version;
      }
      return out;
    };
    return tx ? run(tx) : this.prisma.$transaction(run);
  }

  /** Load a stream's events in version order (for folding into state). */
  async loadStream(
    streamType: StreamType,
    streamId: string,
  ): Promise<StoredEvent[]> {
    const rows = await this.prisma.domainEvent.findMany({
      where: { streamType, streamId },
      orderBy: { version: 'asc' },
    });
    return rows.map((r) => this.toStored(r));
  }

  /**
   * Read events by type across streams (for projections / analytics). Ordered by
   * global sequence so a projector can resume deterministically from a cursor.
   */
  async readByType(
    type: string,
    opts: { afterGlobalSeq?: bigint; take?: number } = {},
  ): Promise<StoredEvent[]> {
    const rows = await this.prisma.domainEvent.findMany({
      where: {
        type,
        ...(opts.afterGlobalSeq != null
          ? { globalSeq: { gt: opts.afterGlobalSeq } }
          : {}),
      },
      orderBy: { globalSeq: 'asc' },
      take: opts.take ?? 500,
    });
    return rows.map((r) => this.toStored(r));
  }

  /**
   * Replay the whole log in total order from a cursor (Phase 13: event replay).
   * Projectors call this on cold start / rebuild, then tail with the returned
   * cursor. Returns events and the new cursor (last globalSeq seen).
   */
  async replay(
    afterGlobalSeq: bigint = 0n,
    take = 1000,
  ): Promise<{ events: StoredEvent[]; cursor: bigint }> {
    const rows = await this.prisma.domainEvent.findMany({
      where: { globalSeq: { gt: afterGlobalSeq } },
      orderBy: { globalSeq: 'asc' },
      take,
    });
    const events = rows.map((r) => this.toStored(r));
    const cursor = events.length
      ? events[events.length - 1].globalSeq
      : afterGlobalSeq;
    return { events, cursor };
  }

  private toStored(row: {
    id: string;
    streamType: string;
    streamId: string;
    version: number;
    type: string;
    payload: Prisma.JsonValue;
    metadata: Prisma.JsonValue | null;
    occurredAt: Date;
    globalSeq: bigint;
  }): StoredEvent {
    return {
      id: row.id,
      streamType: row.streamType as StreamType,
      streamId: row.streamId,
      version: row.version,
      type: row.type as StoredEvent['type'],
      payload: (row.payload ?? {}) as Record<string, unknown>,
      metadata: (row.metadata ?? null) as EventMetadata | null,
      occurredAt: row.occurredAt,
      globalSeq: row.globalSeq,
    };
  }
}
