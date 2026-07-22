import { Injectable } from '@nestjs/common';
import {
  EncounterStatus,
  OpPaymentMode,
  PaymentStatus,
  RegistrationSource,
} from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { OpConfigService } from '../config-engine/op-config.service';
import { SessionKey } from '../queue-engine/token.service';
import { BookingRosterView } from './reception.dto';

/**
 * Read-cutover compatibility (Task 5, reversible). Serves the reception check-in
 * roster from the NEW aggregates (Encounter + Token + CheckIn + Registration +
 * OpPayment) while preserving the LEGACY `BookingRosterView` wire shape, so the
 * reception app needs no change to read new-engine data.
 *
 * Gated per clinic by config `reads.cutover.roster` (default FALSE) — flip a
 * single clinic on when its desk app is ready, flip back instantly if not. Legacy
 * remains the default, so the suite and every un-flipped clinic are untouched.
 *
 * Known reduction: the new model has one session per doctor+day (no MORNING/
 * EVENING split), so a flipped roster returns the whole day's encounters for the
 * doctor. Unlike the legacy roster it ALSO surfaces pre-token encounters
 * (register-only app/voice patients, tokenNumber null) so the desk can check them
 * in — that check-in is what issues their token + enqueues them into the new
 * engine (see ReceptionService.setArrivedEncounter). Without this they would be
 * invisible on a flipped desk and could never be processed.
 */
@Injectable()
export class LegacyRosterCompatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: OpConfigService,
  ) {}

  /** Is the new-model roster read enabled for this clinic? */
  enabled(clinicId: string): Promise<boolean> {
    return this.config.get('reads.cutover.roster', { clinicId }, false);
  }

  /** The session roster, built from the new aggregates in the legacy shape. */
  async roster(session: SessionKey): Promise<BookingRosterView[]> {
    const day = new Date(`${session.sessionDate.slice(0, 10)}T00:00:00.000Z`);
    const encounters = await this.prisma.encounter.findMany({
      where: { doctorId: session.doctorId, serviceDate: day },
      select: { id: true, status: true, legacyBookingId: true, patientId: true },
    });
    if (encounters.length === 0) return [];

    const ids = encounters.map((e) => e.id);
    const [tokens, checkIns, regs, patients, payments] = await Promise.all([
      this.prisma.token.findMany({ where: { encounterId: { in: ids }, voidedAt: null }, select: { encounterId: true, displayNumber: true } }),
      this.prisma.checkIn.findMany({ where: { encounterId: { in: ids } }, select: { encounterId: true, checkedInAt: true } }),
      this.prisma.registration.findMany({ where: { encounterId: { in: ids } }, select: { encounterId: true, source: true } }),
      this.prisma.patient.findMany({ where: { id: { in: encounters.map((e) => e.patientId) } }, select: { id: true, name: true } }),
      this.prisma.opPayment.findMany({ where: { encounterId: { in: ids } }, select: { encounterId: true, status: true, mode: true } }),
    ]);

    const tokenBy = new Map(tokens.map((t) => [t.encounterId, t.displayNumber]));
    const checkInBy = new Map(checkIns.map((c) => [c.encounterId, c.checkedInAt]));
    const sourceBy = new Map(regs.map((r) => [r.encounterId, r.source]));
    const nameBy = new Map(patients.map((p) => [p.id, p.name]));
    const paysBy = new Map<string, { status: PaymentStatus; mode: OpPaymentMode }[]>();
    for (const p of payments) {
      (paysBy.get(p.encounterId) ?? paysBy.set(p.encounterId, []).get(p.encounterId)!).push(p);
    }

    const rows: BookingRosterView[] = [];
    for (const e of encounters) {
      const tokenNumber = tokenBy.get(e.id) ?? null;
      // Include pre-token (register-only) encounters too — checking them in at the
      // desk is what issues their token + enqueues them.
      const source = sourceBy.get(e.id);
      const checkedInAt = checkInBy.get(e.id) ?? null;
      const pays = paysBy.get(e.id) ?? [];
      rows.push({
        bookingId: e.legacyBookingId ?? e.id, // real bookingId if migrated, else encounterId
        tokenNumber,
        patientName: nameBy.get(e.patientId) ?? 'Patient',
        source: mapSource(source),
        status: mapStatus(e.status),
        arrived: checkedInAt !== null,
        checkedInAt: checkedInAt ? checkedInAt.toISOString() : null,
        payAtDesk: source === RegistrationSource.VOICE_AGENT || pays.some((p) => p.mode !== OpPaymentMode.ONLINE),
        paid: pays.some((p) => p.status === PaymentStatus.SUCCESS),
      });
    }
    // token order, like the legacy roster
    rows.sort((a, b) => (a.tokenNumber ?? '').localeCompare(b.tokenNumber ?? ''));
    return rows;
  }
}

/** EncounterStatus → the legacy BookingStatus string the reception app expects. */
function mapStatus(s: EncounterStatus): string {
  switch (s) {
    case EncounterStatus.IN_CONSULTATION:
    case EncounterStatus.PAUSED:
      return 'ACTIVE';
    case EncounterStatus.COMPLETED:
      return 'COMPLETED';
    case EncounterStatus.NO_SHOW:
      return 'NO_SHOW';
    case EncounterStatus.CANCELLED:
    case EncounterStatus.TRANSFERRED:
      return 'CANCELLED';
    default:
      // TOKEN_ISSUED / WAITING / CALLED / SKIPPED / RECALLED — token-holding, in play
      return 'BOOKED';
  }
}

/** RegistrationSource → legacy BookingSource. */
function mapSource(s: RegistrationSource | undefined): string {
  switch (s) {
    case RegistrationSource.VOICE_AGENT:
      return 'VOICE';
    case RegistrationSource.RECEPTION:
      return 'WALK_IN';
    case RegistrationSource.APP:
    default:
      return 'APP';
  }
}
