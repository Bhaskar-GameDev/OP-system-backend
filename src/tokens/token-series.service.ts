import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Token, TokenResetPolicy, TokenSeries } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { EventStoreService } from '../event-store/event-store.service';
import { DomainEventType } from '../event-store/domain-event.types';
import { StateMachineService } from '../state-machine/state-machine.service';

export interface IssuedToken {
  tokenId: string;
  displayNumber: string;
  sequence: number;
  seriesId: string;
}

/**
 * Token engine (ARCHITECTURE.md §5.2, Phase 4).
 *
 * Tokens are RENDERED from a configurable TokenSeries — prefix, pad width, start
 * value, and reset policy are all data. NOTHING is hardcoded (no N/S/W baked in).
 *
 * Allocation is a single Redis INCR (atomic, server-side): N concurrent callers
 * always get N distinct, contiguous sequence values — no read-modify-write.
 *
 * Hard rule: a token is issued ONLY after check-in. The Encounter state machine
 * rejects ISSUE_TOKEN before CHECKED_IN, so this service cannot mint a token for
 * an un-arrived patient even if called directly.
 */
@Injectable()
export class TokenSeriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly events: EventStoreService,
    private readonly sm: StateMachineService,
  ) {}

  /** Render a display number from series config + a 1-based display sequence. */
  render(series: Pick<TokenSeries, 'prefix' | 'padWidth'>, displaySeq: number): string {
    return `${series.prefix}${String(displaySeq).padStart(series.padWidth, '0')}`;
  }

  /**
   * Redis counter key. The SCOPE is derived from the series' reset policy, so the
   * same series resets on the configured boundary:
   *  - PER_SESSION: per doctor + service date (a doctor's sitting)
   *  - DAILY:       per clinic + date
   *  - WEEKLY:      per clinic + ISO week
   *  - NEVER:       lifetime, per series
   */
  counterKey(
    series: Pick<TokenSeries, 'id' | 'clinicId' | 'resetPolicy'>,
    ctx: { doctorId: string; serviceDate: string },
  ): string {
    const d = ctx.serviceDate.slice(0, 10);
    let scope: string;
    switch (series.resetPolicy) {
      case TokenResetPolicy.PER_SESSION:
        scope = `${ctx.doctorId}:${d}`;
        break;
      case TokenResetPolicy.DAILY:
        scope = `${series.clinicId}:${d}`;
        break;
      case TokenResetPolicy.WEEKLY:
        scope = `${series.clinicId}:${isoWeek(d)}`;
        break;
      case TokenResetPolicy.NEVER:
      default:
        scope = 'lifetime';
        break;
    }
    return `pfos:tokenseq:${series.id}:${scope}`;
  }

  /**
   * The number the legacy engine already quoted for this visit, if any.
   *
   * During the dual-write cutover one visit exists in both engines. If each
   * minted its own number the patient would hold a slip that matches neither the
   * doctor's screen nor the reception roster, depending on which surface has its
   * cutover flag set. So the rule is: whichever engine first quotes a number to a
   * human owns it, and the other carries it. An app booking gets its number at
   * payment confirm (the patient sees it immediately), long before the desk
   * checks them in — so OP adopts it here. Walk-in and voice reach this with the
   * legacy row still token-less, so OP mints and legacy carries ours instead.
   *
   * Returns null when there is no legacy row or it has no token yet, which is
   * also the whole post-teardown behaviour: mint normally.
   */
  private async legacyTokenFor(enc: {
    id: string;
    legacyBookingId: string | null;
  }): Promise<string | null> {
    let bookingId = enc.legacyBookingId;
    if (!bookingId) {
      const reg = await this.prisma.registration.findFirst({
        where: { encounterId: enc.id },
        select: { channelMeta: true },
      });
      const meta = reg?.channelMeta as { legacyBookingId?: string } | null;
      bookingId = meta?.legacyBookingId ?? null;
    }
    if (!bookingId) return null;

    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { tokenNumber: true },
    });
    return booking?.tokenNumber ?? null;
  }

  /**
   * Issue the next token for an encounter. Requires the encounter to be
   * CHECKED_IN (enforced via the state machine). Idempotent: a second call for
   * the same encounter returns the token already issued.
   */
  async issueForEncounter(
    encounterId: string,
    actorId?: string,
  ): Promise<IssuedToken> {
    const enc = await this.prisma.encounter.findUnique({
      where: { id: encounterId },
    });
    if (!enc) throw new NotFoundException('encounter not found');

    // Idempotency — token already issued for this encounter.
    const existing = await this.prisma.token.findUnique({
      where: { encounterId },
    });
    if (existing && !existing.voidedAt) {
      return {
        tokenId: existing.id,
        displayNumber: existing.displayNumber,
        sequence: existing.sequence,
        seriesId: existing.seriesId,
      };
    }

    // Legality: only from CHECKED_IN (throws 400 otherwise).
    const nextStatus = this.sm.nextEncounter(enc.status, 'ISSUE_TOKEN');

    const series = await this.prisma.tokenSeries.findUnique({
      where: { id: enc.opCategoryId },
    });
    if (!series) throw new BadRequestException('token series not found');
    if (!series.active) throw new BadRequestException('token series inactive');

    const serviceDate = enc.serviceDate.toISOString().slice(0, 10);
    const key = this.counterKey(series, { doctorId: enc.doctorId, serviceDate });

    // Atomic allocation. displaySeq honours the series' configured startAt.
    // The counter is INCR'd even when a legacy number is adopted below, so the
    // series stays dense and later self-minted tokens don't collide.
    const raw = await this.redis.redis.incr(key);
    const displaySeq = series.startAt - 1 + raw;
    // ONE number per visit: if the legacy engine already quoted this patient a
    // token (an app booking shows it from the moment payment succeeds), adopt it
    // rather than minting a second one. Walk-in and voice reach here with the
    // legacy row still token-less, so those mint here and legacy carries ours.
    const displayNumber =
      (await this.legacyTokenFor(enc)) ?? this.render(series, displaySeq);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const version = await this.events.currentVersion(
          'Encounter',
          enc.id,
          tx,
        );
        const token: Token = await tx.token.create({
          data: {
            encounterId: enc.id,
            seriesId: series.id,
            sequence: displaySeq,
            displayNumber,
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
            type: DomainEventType.TokenIssued,
            payload: {
              tokenId: token.id,
              seriesId: series.id,
              seriesCode: series.code,
              displayNumber,
              sequence: displaySeq,
            },
            metadata: { actorId, clinicId: enc.clinicId },
          },
          version,
          tx,
        );
        return {
          tokenId: token.id,
          displayNumber,
          sequence: displaySeq,
          seriesId: series.id,
        };
      });
    } catch (e) {
      if (
        e instanceof ConflictException ||
        (e as { code?: string }).code === 'P2002'
      ) {
        // Lost a race — the other writer issued the token; return theirs.
        const t = await this.prisma.token.findUnique({ where: { encounterId } });
        if (t) {
          return {
            tokenId: t.id,
            displayNumber: t.displayNumber,
            sequence: t.sequence,
            seriesId: t.seriesId,
          };
        }
      }
      throw e;
    }
  }

  /** Current counter value without allocating (0 if none issued in scope). */
  async peek(
    series: Pick<TokenSeries, 'id' | 'clinicId' | 'resetPolicy' | 'startAt'>,
    ctx: { doctorId: string; serviceDate: string },
  ): Promise<number> {
    const v = await this.redis.redis.get(this.counterKey(series, ctx));
    return v ? Number.parseInt(v, 10) : 0;
  }
}

/** ISO-8601 week key "YYYY-Www" for the WEEKLY reset scope. */
function isoWeek(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - day + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((d.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
