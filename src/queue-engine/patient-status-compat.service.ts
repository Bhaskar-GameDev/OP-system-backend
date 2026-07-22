import { Injectable } from '@nestjs/common';
import { EncounterStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { OpConfigService } from '../config-engine/op-config.service';
import type { MyQueueStatus } from './queue-status.controller';

type Booking = {
  id: string;
  doctorId: string;
  tokenNumber: string | null;
};

const TERMINAL: EncounterStatus[] = [
  EncounterStatus.COMPLETED,
  EncounterStatus.NO_SHOW,
  EncounterStatus.CANCELLED,
  EncounterStatus.TRANSFERRED,
];

/**
 * Read-cutover compatibility for the patient's own live status (Task 5,
 * reversible). Serves `GET /queue/my-status` from the NEW engine's read model in
 * the unchanged `MyQueueStatus` shape, so the patient app needs no change.
 *
 * Gated per clinic by config `reads.cutover.patientStatus` (default FALSE), and
 * additionally **falls back to legacy** (returns null) when the booking's
 * encounter is not yet in the new queue — during the transition a patient tracked
 * only in the legacy queue keeps their legacy status until new-path check-in
 * enqueues them. Never throws.
 */
@Injectable()
export class PatientStatusCompatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: OpConfigService,
  ) {}

  /** New-engine status for a booking, or null to fall back to the legacy path. */
  async tryStatus(booking: Booking): Promise<MyQueueStatus | null> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: booking.doctorId },
      select: { clinicId: true, avgConsultMinutes: true },
    });
    if (!doctor) return null;

    const enabled = await this.config.get(
      'reads.cutover.patientStatus',
      { clinicId: doctor.clinicId },
      false,
    );
    if (!enabled) return null;

    const encounterId = await this.resolveEncounterId(booking.id);
    if (!encounterId) return null;

    const me = await this.prisma.queueReadModel.findUnique({
      where: { encounterId },
    });
    if (!me) return null; // not projected into the new queue yet -> legacy

    const token = me.tokenNumber ?? booking.tokenNumber ?? '';

    // Terminal: left the queue (completed / no-show / cancelled / transferred).
    if (TERMINAL.includes(me.status)) {
      return {
        bookingId: booking.id,
        tokenNumber: token,
        servingToken: null,
        patientsAhead: 0,
        position: 0,
        total: 0,
        etaMinutes: 0,
        status: 'done',
      };
    }

    let ahead = 0;
    let servingToken: string | null = null;
    let total = 0;
    if (me.opSessionId) {
      if (me.orderKey != null) {
        ahead = await this.prisma.queueReadModel.count({
          where: {
            opSessionId: me.opSessionId,
            status: EncounterStatus.WAITING,
            orderKey: { lt: me.orderKey },
          },
        });
      }
      const serving = await this.prisma.queueReadModel.findFirst({
        where: {
          opSessionId: me.opSessionId,
          status: EncounterStatus.IN_CONSULTATION,
        },
        orderBy: { updatedAt: 'desc' },
        select: { tokenNumber: true },
      });
      servingToken = serving?.tokenNumber ?? null;
      total = await this.prisma.queueReadModel.count({
        where: {
          opSessionId: me.opSessionId,
          status: {
            in: [EncounterStatus.WAITING, EncounterStatus.IN_CONSULTATION],
          },
        },
      });
    }

    const beingSeen = me.status === EncounterStatus.IN_CONSULTATION;
    return {
      bookingId: booking.id,
      tokenNumber: token,
      servingToken,
      patientsAhead: beingSeen ? 0 : ahead,
      position: beingSeen ? 0 : ahead + 1,
      total,
      etaMinutes: beingSeen ? 0 : ahead * doctor.avgConsultMinutes,
      status: beingSeen ? 'in_consultation' : labelFor(ahead),
    };
  }

  /** bookingId -> encounterId, via the backfill column or the mirror channelMeta. */
  private async resolveEncounterId(bookingId: string): Promise<string | null> {
    const byColumn = await this.prisma.encounter.findUnique({
      where: { legacyBookingId: bookingId },
      select: { id: true },
    });
    if (byColumn) return byColumn.id;
    const reg = await this.prisma.registration.findFirst({
      where: { channelMeta: { path: ['legacyBookingId'], equals: bookingId } },
      select: { encounterId: true },
    });
    return reg?.encounterId ?? null;
  }
}

function labelFor(patientsAhead: number): 'waiting' | 'next' | 'in_consultation' {
  if (patientsAhead === 0) return 'in_consultation';
  if (patientsAhead === 1) return 'next';
  return 'waiting';
}
