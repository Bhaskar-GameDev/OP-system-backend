import { Injectable } from '@nestjs/common';
import { EncounterStatus, QueueReadModel } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';

export interface DisplayBoard {
  nowServing: { tokenNumber: string | null; patientName: string } | null;
  next: { tokenNumber: string | null; patientName: string }[];
}

export interface PatientTracking {
  tokenNumber: string | null;
  status: EncounterStatus;
  ahead: number; // people ahead in the queue
  nowServingToken: string | null;
}

/**
 * Read models (ARCHITECTURE.md §12.2, Phase 14). Every view is a fast query over
 * the QueueReadModel projection — no joins across the write aggregates, no source
 * in ordering. Optimized per consumer: live queue, doctor dashboard, reception
 * roster, display board, patient tracking.
 */
@Injectable()
export class QueueReadService {
  constructor(private readonly prisma: PrismaService) {}

  /** Live queue for a session: waiting patients in arrival order. */
  liveQueue(opSessionId: string): Promise<QueueReadModel[]> {
    return this.prisma.queueReadModel.findMany({
      where: { opSessionId, status: EncounterStatus.WAITING },
      orderBy: { orderKey: 'asc' },
    });
  }

  /** Doctor dashboard: who is being seen + the waiting line. */
  async doctorDashboard(doctorId: string): Promise<{
    active: QueueReadModel | null;
    waiting: QueueReadModel[];
  }> {
    const active = await this.prisma.queueReadModel.findFirst({
      where: { doctorId, status: EncounterStatus.IN_CONSULTATION },
      orderBy: { updatedAt: 'desc' },
    });
    const waiting = await this.prisma.queueReadModel.findMany({
      where: { doctorId, status: EncounterStatus.WAITING },
      orderBy: { orderKey: 'asc' },
    });
    return { active, waiting };
  }

  /** Reception roster: everyone in the clinic today, grouped by status. */
  async receptionRoster(
    clinicId: string,
  ): Promise<Record<string, QueueReadModel[]>> {
    const rows = await this.prisma.queueReadModel.findMany({
      where: { clinicId },
      orderBy: { orderKey: 'asc' },
    });
    return rows.reduce<Record<string, QueueReadModel[]>>((acc, r) => {
      (acc[r.status] ??= []).push(r);
      return acc;
    }, {});
  }

  /** Public display board: now serving + the next few tokens. */
  async displayBoard(opSessionId: string, take = 5): Promise<DisplayBoard> {
    const active = await this.prisma.queueReadModel.findFirst({
      where: { opSessionId, status: EncounterStatus.IN_CONSULTATION },
      orderBy: { updatedAt: 'desc' },
    });
    const next = await this.prisma.queueReadModel.findMany({
      where: { opSessionId, status: EncounterStatus.WAITING },
      orderBy: { orderKey: 'asc' },
      take,
    });
    return {
      nowServing: active
        ? { tokenNumber: active.tokenNumber, patientName: active.patientName }
        : null,
      next: next.map((n) => ({
        tokenNumber: n.tokenNumber,
        patientName: n.patientName,
      })),
    };
  }

  /** Patient's own live tracking: token, status, how many ahead, now-serving. */
  async patientTracking(encounterId: string): Promise<PatientTracking | null> {
    const me = await this.prisma.queueReadModel.findUnique({
      where: { encounterId },
    });
    if (!me) return null;
    let ahead = 0;
    let nowServingToken: string | null = null;
    if (me.opSessionId && me.orderKey != null) {
      ahead = await this.prisma.queueReadModel.count({
        where: {
          opSessionId: me.opSessionId,
          status: EncounterStatus.WAITING,
          orderKey: { lt: me.orderKey },
        },
      });
      const serving = await this.prisma.queueReadModel.findFirst({
        where: {
          opSessionId: me.opSessionId,
          status: EncounterStatus.IN_CONSULTATION,
        },
        orderBy: { updatedAt: 'desc' },
      });
      nowServingToken = serving?.tokenNumber ?? null;
    }
    return {
      tokenNumber: me.tokenNumber,
      status: me.status,
      ahead,
      nowServingToken,
    };
  }
}
