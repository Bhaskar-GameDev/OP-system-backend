import { Injectable, NotFoundException } from '@nestjs/common';
import { OpSession, OpSessionState, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { EventStoreService } from '../event-store/event-store.service';
import { DomainEventType } from '../event-store/domain-event.types';

/**
 * A doctor's live consulting window for a date (ARCHITECTURE.md §5, §9).
 * Replaces the appointment-era QueueSession/MORNING-EVENING coupling — a session
 * is just doctor + date; its shape comes from a configurable SessionTemplate.
 */
@Injectable()
export class OpSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventStoreService,
  ) {}

  /** Get-or-create the live session for a doctor on a date (idempotent). */
  async getOrCreate(
    doctorId: string,
    clinicId: string,
    serviceDate: string,
  ): Promise<OpSession> {
    const date = this.toDate(serviceDate);
    const existing = await this.prisma.opSession.findFirst({
      where: { doctorId, serviceDate: date },
    });
    if (existing) return existing;
    try {
      return await this.prisma.opSession.create({
        data: { doctorId, clinicId, serviceDate: date },
      });
    } catch (e) {
      // Concurrent create — return the row the other writer made.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const row = await this.prisma.opSession.findFirst({
          where: { doctorId, serviceDate: date },
        });
        if (row) return row;
      }
      throw e;
    }
  }

  /** Move to OPEN (accepting/serving). Emits OpSessionOpened once. */
  async open(sessionId: string): Promise<OpSession> {
    return this.transition(sessionId, OpSessionState.OPEN, [
      OpSessionState.SCHEDULED,
      OpSessionState.PAUSED,
    ], DomainEventType.OpSessionOpened);
  }

  /** Doctor pause — stops calling; ETAs freeze (§9). Emits OpSessionPaused. */
  async pause(sessionId: string): Promise<OpSession> {
    return this.transition(
      sessionId,
      OpSessionState.PAUSED,
      [OpSessionState.OPEN],
      DomainEventType.OpSessionPaused,
    );
  }

  /** Resume after pause. Emits OpSessionResumed. */
  async resume(sessionId: string): Promise<OpSession> {
    return this.transition(
      sessionId,
      OpSessionState.OPEN,
      [OpSessionState.PAUSED],
      DomainEventType.OpSessionResumed,
    );
  }

  /** Close the session (end of sitting). Emits OpSessionClosed. */
  async close(sessionId: string): Promise<OpSession> {
    return this.transition(
      sessionId,
      OpSessionState.CLOSED,
      [OpSessionState.OPEN, OpSessionState.PAUSED, OpSessionState.SCHEDULED],
      DomainEventType.OpSessionClosed,
    );
  }

  async get(sessionId: string): Promise<OpSession> {
    const s = await this.prisma.opSession.findUnique({
      where: { id: sessionId },
    });
    if (!s) throw new NotFoundException('op session not found');
    return s;
  }

  private async transition(
    sessionId: string,
    to: OpSessionState,
    allowedFrom: OpSessionState[],
    eventType: DomainEventType,
  ): Promise<OpSession> {
    const s = await this.get(sessionId);
    if (s.state === to) return s; // idempotent
    if (!allowedFrom.includes(s.state)) {
      throw new NotFoundException(
        `illegal session transition ${s.state} -> ${to}`,
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const version = await this.events.currentVersion(
        'OpSession',
        sessionId,
        tx,
      );
      const updated = await tx.opSession.update({
        where: { id: sessionId },
        data: {
          state: to,
          ...(to === OpSessionState.OPEN && !s.openedAt
            ? { openedAt: new Date() }
            : {}),
          ...(to === OpSessionState.CLOSED ? { closedAt: new Date() } : {}),
        },
      });
      await this.events.append(
        {
          streamType: 'OpSession',
          streamId: sessionId,
          type: eventType,
          payload: { from: s.state, to },
          metadata: { clinicId: s.clinicId },
        },
        version,
        tx,
      );
      return updated;
    });
  }

  private toDate(iso: string): Date {
    return new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
  }
}
