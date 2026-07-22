import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { QueueEntry, QueuePolicyMode } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { EventStoreService } from '../event-store/event-store.service';
import { DomainEventType } from '../event-store/domain-event.types';
import { StateMachineService } from '../state-machine/state-machine.service';
import { OpSessionService } from './op-session.service';
import { QueuePolicyService } from './queue-policy.service';

export interface QueueCandidate {
  encounterId: string;
  category: string; // TokenSeries.code
  score: number; // arrival order key
}

export interface EnqueueResult {
  entry: QueueEntry;
  opSessionId: string;
  category: string;
}

/**
 * The queue engine (ARCHITECTURE.md §5, Phases 5+6).
 *
 * It answers exactly ONE question — "who should be called next for this doctor?"
 * — using queue order + token-category rules + policy. It is BLIND to
 * registration source and to payment status by construction: neither is read
 * here, and the Encounter carries no source column for it to read.
 *
 * Ordering lives in Redis (a sorted set per session per category). The relational
 * QueueEntry is the durable record; Redis is the fast projection and holds
 * exactly the WAITING members (removed on call / skip / no-show).
 */
@Injectable()
export class OpQueueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly events: EventStoreService,
    private readonly sm: StateMachineService,
    private readonly sessions: OpSessionService,
    private readonly policies: QueuePolicyService,
  ) {}

  // ── Redis keys ─────────────────────────────────────────
  private kSeq(s: string) { return `pfos:q:seq:${s}`; }
  private kCats(s: string) { return `pfos:q:cats:${s}`; }
  private kLine(s: string, code: string) { return `pfos:q:${s}:${code}`; }
  private kServed(s: string) { return `pfos:q:served:${s}`; }
  private kActive(s: string) { return `pfos:q:active:${s}`; }

  /**
   * Place a checked-in, tokened encounter into its doctor's live queue.
   * Requires status TOKEN_ISSUED (the state machine rejects raw registrations —
   * a queue can NEVER contain a registration). Idempotent per encounter.
   */
  async enqueue(encounterId: string): Promise<EnqueueResult> {
    const enc = await this.prisma.encounter.findUnique({
      where: { id: encounterId },
    });
    if (!enc) throw new NotFoundException('encounter not found');

    const existing = await this.prisma.queueEntry.findUnique({
      where: { encounterId },
    });
    const series = await this.prisma.tokenSeries.findUnique({
      where: { id: enc.opCategoryId },
      select: { code: true },
    });
    if (!series) throw new BadRequestException('token series not found');
    const category = series.code;

    if (existing) {
      return { entry: existing, opSessionId: existing.opSessionId, category };
    }

    const token = await this.prisma.token.findUnique({
      where: { encounterId },
      select: { id: true },
    });
    if (!token) throw new BadRequestException('no token issued for encounter');

    // Legality: only TOKEN_ISSUED -> WAITING (throws 400 otherwise).
    const nextStatus = this.sm.nextEncounter(enc.status, 'ENQUEUE');

    const session = await this.sessions.getOrCreate(
      enc.doctorId,
      enc.clinicId,
      enc.serviceDate.toISOString().slice(0, 10),
    );
    await this.sessions.open(session.id);

    // Monotonic arrival order (atomic). Strict FIFO within a category.
    const orderKey = await this.redis.redis.incr(this.kSeq(session.id));

    const entry = await this.prisma.$transaction(async (tx) => {
      const version = await this.events.currentVersion(
        'Encounter',
        enc.id,
        tx,
      );
      const created = await tx.queueEntry.create({
        data: {
          encounterId: enc.id,
          opSessionId: session.id,
          tokenId: token.id,
          orderKey,
        },
      });
      await tx.encounter.update({
        where: { id: enc.id },
        data: { status: nextStatus },
      });
      await this.events.append(
        {
          streamType: 'Encounter',
          streamId: enc.id,
          type: DomainEventType.QueueEntered,
          payload: { opSessionId: session.id, category, orderKey },
          metadata: { clinicId: enc.clinicId },
        },
        version,
        tx,
      );
      return created;
    });

    await this.redis.redis
      .multi()
      .sadd(this.kCats(session.id), category)
      .zadd(this.kLine(session.id, category), orderKey, enc.id)
      .exec();

    return { entry, opSessionId: session.id, category };
  }

  /**
   * Peek the next candidate per policy. Pure read — does NOT mutate the queue.
   * The caller (consultation "Call Next", Phase 7) commits the choice.
   *
   * @param opts.category required for INDEPENDENT; overrides active for MANUAL_SWITCH.
   */
  async whoNext(
    opSessionId: string,
    opts: { category?: string } = {},
  ): Promise<QueueCandidate | null> {
    const session = await this.sessions.get(opSessionId);
    const policy = await this.policies.resolve(
      session.clinicId,
      session.doctorId,
    );
    const heads = await this.heads(opSessionId);
    if (heads.length === 0) return null;

    switch (policy.mode) {
      case QueuePolicyMode.SHARED_FIFO:
        return this.minScore(heads);

      case QueuePolicyMode.INDEPENDENT: {
        if (!opts.category) {
          throw new BadRequestException(
            'category required for INDEPENDENT queue policy',
          );
        }
        return heads.find((h) => h.category === opts.category) ?? null;
      }

      case QueuePolicyMode.MANUAL_SWITCH: {
        const active =
          opts.category ??
          (await this.redis.redis.get(this.kActive(opSessionId))) ??
          this.minScore(heads)!.category; // fall back to earliest if unset
        return heads.find((h) => h.category === active) ?? null;
      }

      case QueuePolicyMode.RATIO:
        return this.pickByRatio(opSessionId, heads, policy.weights);

      default:
        return this.minScore(heads);
    }
  }

  /** Set the active category for a MANUAL_SWITCH queue. */
  async setActiveCategory(
    opSessionId: string,
    category: string,
  ): Promise<void> {
    await this.redis.redis.set(this.kActive(opSessionId), category);
  }

  /** Ordered snapshot of everyone waiting (for dashboards / display board). */
  async listWaiting(opSessionId: string): Promise<QueueCandidate[]> {
    const cats = await this.redis.redis.smembers(this.kCats(opSessionId));
    const all: QueueCandidate[] = [];
    for (const category of cats) {
      const raw = await this.redis.redis.zrange(
        this.kLine(opSessionId, category),
        0,
        -1,
        'WITHSCORES',
      );
      for (let i = 0; i < raw.length; i += 2) {
        all.push({ encounterId: raw[i], category, score: Number(raw[i + 1]) });
      }
    }
    return all.sort((a, b) => a.score - b.score);
  }

  /**
   * Remove an encounter from the Redis queue and (optionally) record it as served
   * against its category — used when the encounter is called / skipped / removed.
   * Called by the consultation engine (Phase 7). recordServed advances the RATIO
   * counter so weighted interleaving progresses.
   */
  async dequeue(
    opSessionId: string,
    encounterId: string,
    category: string,
    opts: { recordServed?: boolean } = {},
  ): Promise<void> {
    const m = this.redis.redis.multi();
    m.zrem(this.kLine(opSessionId, category), encounterId);
    if (opts.recordServed) {
      m.hincrby(this.kServed(opSessionId), category, 1);
    }
    await m.exec();
  }

  /** Re-add an encounter to the tail of its category (skip re-insert / recall). */
  async requeue(
    opSessionId: string,
    encounterId: string,
    category: string,
  ): Promise<number> {
    const orderKey = await this.redis.redis.incr(this.kSeq(opSessionId));
    await this.redis.redis
      .multi()
      .sadd(this.kCats(opSessionId), category)
      .zadd(this.kLine(opSessionId, category), orderKey, encounterId)
      .exec();
    return orderKey;
  }

  /** Re-add to the FRONT of its category (recall with reinsertPosition=front). */
  async requeueFront(
    opSessionId: string,
    encounterId: string,
    category: string,
  ): Promise<number> {
    const head = await this.redis.redis.zrange(
      this.kLine(opSessionId, category),
      0,
      0,
      'WITHSCORES',
    );
    const minScore = head.length === 2 ? Number(head[1]) : 0;
    const score = minScore - 1; // ahead of the current head
    await this.redis.redis
      .multi()
      .sadd(this.kCats(opSessionId), category)
      .zadd(this.kLine(opSessionId, category), score, encounterId)
      .exec();
    return score;
  }

  // ── internals ──────────────────────────────────────────

  /** Head (lowest score) of each non-empty category line. */
  private async heads(opSessionId: string): Promise<QueueCandidate[]> {
    const cats = await this.redis.redis.smembers(this.kCats(opSessionId));
    const out: QueueCandidate[] = [];
    for (const category of cats) {
      const raw = await this.redis.redis.zrange(
        this.kLine(opSessionId, category),
        0,
        0,
        'WITHSCORES',
      );
      if (raw.length === 2) {
        out.push({ encounterId: raw[0], category, score: Number(raw[1]) });
      }
    }
    return out;
  }

  private minScore(heads: QueueCandidate[]): QueueCandidate | null {
    if (heads.length === 0) return null;
    return heads.reduce((a, b) => (a.score <= b.score ? a : b));
  }

  /**
   * Weighted interleave: pick the category whose served count is lowest RELATIVE
   * to its weight, i.e. minimize served[c]/weight[c]. Over many calls this yields
   * the configured ratio (e.g. {SPECIAL:2, NORMAL:1} -> S,S,N,S,S,N…). Ties break
   * by earliest arrival so FIFO holds within the interleave.
   */
  private async pickByRatio(
    opSessionId: string,
    heads: QueueCandidate[],
    weights: Record<string, number>,
  ): Promise<QueueCandidate> {
    const served = await this.redis.redis.hgetall(this.kServed(opSessionId));
    let best: QueueCandidate | null = null;
    let bestRatio = Infinity;
    for (const h of heads) {
      const w = weights[h.category] ?? 1;
      const s = Number(served[h.category] ?? 0);
      const r = s / w;
      if (
        r < bestRatio - 1e-9 ||
        (Math.abs(r - bestRatio) <= 1e-9 && (best === null || h.score < best.score))
      ) {
        bestRatio = r;
        best = h;
      }
    }
    return best!;
  }
}
