import { Injectable } from '@nestjs/common';
import { EncounterStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { OpConfigService } from '../config-engine/op-config.service';
import { EtaResult, EtaService } from '../queue-engine/eta.service';
import { SessionKey } from '../queue-engine/token.service';

/**
 * Read-cutover compatibility for the reception desk's LIVE QUEUE — the fourth
 * surface, alongside `LegacyRosterCompatService` (roster),
 * `OpQueueCompatService` (doctor) and `PatientStatusCompatService` (patient).
 *
 * Why it is needed: bookings raised by the voice agent (and any other new-native
 * path) are enqueued in the OP engine, never in the legacy Redis ZSET. The desk's
 * socket snapshot was built purely from that ZSET, so a phone-booked token was
 * invisible in NOW SERVING / IN QUEUE even though the roster listed it — the desk
 * could see the patient existed but not where they stood in line.
 *
 * Gated per clinic by config `reads.cutover.receptionQueue` (default FALSE), so
 * legacy stays the default and a flipped clinic can be flipped back instantly.
 * The wire shape is unchanged (`EtaResult[]`), so the reception app needs no edit.
 *
 * Ordering matches the doctor compat exactly: IN_CONSULTATION (the new engine's
 * ACTIVE) is rank 0 ahead of the WAITING line ordered by `orderKey`, and ETA is
 * the same `patientsAhead × avgConsultMinutes` arithmetic the legacy board uses,
 * so a flipped desk sees the same numbers moving at the same rate.
 */
@Injectable()
export class ReceptionQueueCompatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: OpConfigService,
    private readonly eta: EtaService,
  ) {}

  /** Is the new-model desk queue read enabled for this doctor's clinic? */
  async enabled(doctorId: string): Promise<boolean> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { clinicId: true },
    });
    if (!doctor) return false;
    return this.config.get(
      'reads.cutover.receptionQueue',
      { clinicId: doctor.clinicId },
      false,
    );
  }

  /** The desk's live queue, built from the projection in the legacy shape. */
  async queue(session: SessionKey): Promise<EtaResult[]> {
    // Scope by the day's OpSession, NOT by doctorId alone: the read model retains
    // rows from earlier sessions (dev/test days all mint their own N001), and a
    // doctor-wide query would splice those into today's line.
    const day = new Date(`${session.sessionDate.slice(0, 10)}T00:00:00.000Z`);
    const opSession = await this.prisma.opSession.findFirst({
      where: { doctorId: session.doctorId, serviceDate: day },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!opSession) return [];

    const [active, waiting] = await Promise.all([
      this.prisma.queueReadModel.findFirst({
        where: {
          opSessionId: opSession.id,
          status: EncounterStatus.IN_CONSULTATION,
        },
        orderBy: { updatedAt: 'desc' },
        select: { tokenNumber: true },
      }),
      this.prisma.queueReadModel.findMany({
        where: { opSessionId: opSession.id, status: EncounterStatus.WAITING },
        orderBy: { orderKey: 'asc' },
        select: { tokenNumber: true },
      }),
    ]);

    const ordered = active ? [active, ...waiting] : waiting;
    // A pre-token encounter (registered, not yet issued a token) has no number to
    // show on a board keyed by token, and the roster is where the desk checks
    // those in. Drop them rather than emit blank rows.
    const tokens = ordered
      .map((r) => r.tokenNumber)
      .filter((t): t is string => !!t && t.length > 0);
    if (tokens.length === 0) return [];

    const avg = await this.eta.avgConsultMinutes(session.doctorId);
    const total = tokens.length;
    return tokens.map((tokenNumber, i) => ({
      tokenNumber,
      patientsAhead: i,
      position: i + 1,
      total,
      avgConsultMinutes: avg,
      etaMinutes: i * avg,
    }));
  }
}
