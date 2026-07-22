import { Injectable, NotFoundException } from '@nestjs/common';
import { CheckIn, CheckInMethod, Encounter } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { EventStoreService } from '../event-store/event-store.service';
import { DomainEventType } from '../event-store/domain-event.types';
import { StateMachineService } from '../state-machine/state-machine.service';
import { TokenSeriesService, IssuedToken } from '../tokens/token-series.service';

export interface CheckInResult {
  encounter: Encounter;
  checkIn: CheckIn;
  token?: IssuedToken; // present when a token was issued (combined path / auto)
}

/**
 * Check-in (ARCHITECTURE.md §3, Phase 3).
 *
 * Check-in is the GATE to token issuance. An encounter that has not been checked
 * in can never enter a doctor queue — the state machine forbids ISSUE_TOKEN
 * before CHECKED_IN, so this is structural, not a convention.
 *
 * Token issuance stays a SEPARATE operation (TokenSeriesService). The reception
 * combined path (register + check-in + token in one desk action) is expressed by
 * passing issueToken=true — a composition of the same primitives, not a fork.
 */
@Injectable()
export class CheckInService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventStoreService,
    private readonly sm: StateMachineService,
    private readonly tokens: TokenSeriesService,
  ) {}

  /**
   * Confirm physical presence. Legal from REGISTERED (reception AUTO / combined)
   * or ARRIVED. Idempotent: a second check-in returns the existing record.
   *
   * @param issueToken when true, also allocate the token immediately (reception
   *   desk flow). Otherwise the token is issued later, when the desk chooses.
   */
  async checkIn(
    encounterId: string,
    method: CheckInMethod,
    opts: { checkedInBy?: string; issueToken?: boolean } = {},
  ): Promise<CheckInResult> {
    const enc = await this.prisma.encounter.findUnique({
      where: { id: encounterId },
    });
    if (!enc) throw new NotFoundException('encounter not found');

    const existing = await this.prisma.checkIn.findUnique({
      where: { encounterId },
    });

    let encounter = enc;
    let checkIn = existing;

    if (!existing) {
      // Legality: REGISTERED/ARRIVED -> CHECKED_IN (throws 400 otherwise).
      const next = this.sm.nextEncounter(enc.status, 'CHECK_IN');
      const result = await this.prisma.$transaction(async (tx) => {
        const version = await this.events.currentVersion(
          'Encounter',
          enc.id,
          tx,
        );
        const ci = await tx.checkIn.create({
          data: {
            encounterId: enc.id,
            method,
            checkedInBy: opts.checkedInBy ?? null,
          },
        });
        const updated = await tx.encounter.update({
          where: { id: enc.id },
          data: { status: next },
        });
        await this.events.append(
          {
            streamType: 'Encounter',
            streamId: enc.id,
            type: DomainEventType.PatientCheckedIn,
            payload: { method },
            metadata: { actorId: opts.checkedInBy, clinicId: enc.clinicId },
          },
          version,
          tx,
        );
        return { ci, updated };
      });
      checkIn = result.ci;
      encounter = result.updated;
    }

    let token: IssuedToken | undefined;
    if (opts.issueToken) {
      token = await this.tokens.issueForEncounter(enc.id, opts.checkedInBy);
      encounter = (await this.prisma.encounter.findUnique({
        where: { id: enc.id },
      }))!;
    }

    return { encounter, checkIn: checkIn!, token };
  }
}
