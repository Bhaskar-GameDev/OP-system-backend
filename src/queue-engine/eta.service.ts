import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { QueueService } from './queue.service';
import { SessionKey } from './token.service';

export interface EtaResult {
  tokenNumber: string;
  patientsAhead: number; // 0-based count strictly ahead (ZRANK)
  position: number; // 1-based
  total: number; // current queue size
  avgConsultMinutes: number; // static per-doctor field (V1)
  etaMinutes: number; // patientsAhead * avgConsultMinutes
}

/**
 * Live ETA. NOT stored, NOT recalculated on a schedule.
 *
 * ETA = patientsAhead × doctor.avg_consult_minutes, computed at read/push time.
 * patientsAhead comes from ZRANK, which is exact the instant the sorted set
 * changes (enqueue / DONE / no-show / skip / priority). So ETA inherits
 * correctness for free — there is deliberately no recalc job.
 *
 * avg_consult_minutes is the static doctors-table field for V1. A rolling
 * average is an explicit fast-follow, not built here.
 */
@Injectable()
export class EtaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  private async avgConsultMinutes(doctorId: string): Promise<number> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { avgConsultMinutes: true },
    });
    if (!doctor) throw new NotFoundException(`doctor ${doctorId} not found`);
    return doctor.avgConsultMinutes;
  }

  /** Live ETA for one token. null if the token is not in the queue. */
  async etaFor(token: string, session: SessionKey): Promise<EtaResult | null> {
    const pos = await this.queue.positionOf(token, session);
    if (!pos) return null;
    const avg = await this.avgConsultMinutes(session.doctorId);
    return {
      tokenNumber: pos.tokenNumber,
      patientsAhead: pos.patientsAhead,
      position: pos.position,
      total: pos.total,
      avgConsultMinutes: avg,
      etaMinutes: pos.patientsAhead * avg,
    };
  }

  /** Live ETA for the whole queue (front -> back) — one doctor lookup. */
  async etaForQueue(session: SessionKey): Promise<EtaResult[]> {
    const slots = await this.queue.listWithScores(session);
    if (slots.length === 0) return [];
    const avg = await this.avgConsultMinutes(session.doctorId);
    const total = slots.length;
    return slots.map((slot, i) => ({
      tokenNumber: slot.tokenNumber,
      patientsAhead: i, // index in the ordered set == ZRANK
      position: i + 1,
      total,
      avgConsultMinutes: avg,
      etaMinutes: i * avg,
    }));
  }
}
