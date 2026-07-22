import { Injectable } from '@nestjs/common';
import { QueuePolicyMode } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';

/** Resolved, ready-to-apply queue policy for a doctor's session. */
export interface ResolvedQueuePolicy {
  mode: QueuePolicyMode;
  /** weight per category code, e.g. { SPECIAL_OP: 2, NORMAL_OP: 1 } */
  weights: Record<string, number>;
  skipRules: { maxSkips: number; dropAfter: boolean; reinsertPosition: 'front' | 'back' };
  recallRules: { windowMinutes: number; afterNoShow: boolean };
}

const DEFAULT_SKIP = { maxSkips: 2, dropAfter: true, reinsertPosition: 'back' as const };
const DEFAULT_RECALL = { windowMinutes: 30, afterNoShow: true };

/**
 * Queue policy resolution (ARCHITECTURE.md §5.3, §10, Phase 6).
 *
 * Resolution order: doctor-specific policy → clinic default → SHARED_FIFO. Normal
 * vs Special is NEVER a hardcoded priority — it is whatever the resolved policy
 * says. Registration source is not an input here and never will be.
 */
@Injectable()
export class QueuePolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    clinicId: string,
    doctorId: string,
  ): Promise<ResolvedQueuePolicy> {
    const row =
      (await this.prisma.queuePolicy.findFirst({
        where: { clinicId, doctorId },
      })) ??
      (await this.prisma.queuePolicy.findFirst({
        where: { clinicId, doctorId: null },
      }));

    if (!row) {
      return {
        mode: QueuePolicyMode.SHARED_FIFO,
        weights: {},
        skipRules: DEFAULT_SKIP,
        recallRules: DEFAULT_RECALL,
      };
    }

    return {
      mode: row.mode,
      weights: this.parseWeights(row.ratio),
      skipRules: { ...DEFAULT_SKIP, ...(row.skipRules as object) },
      recallRules: { ...DEFAULT_RECALL, ...(row.recallRules as object) },
    };
  }

  private parseWeights(ratio: unknown): Record<string, number> {
    if (ratio && typeof ratio === 'object') {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(ratio as Record<string, unknown>)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) out[k] = n;
      }
      return out;
    }
    return {};
  }
}
