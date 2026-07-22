import { Injectable, Logger } from '@nestjs/common';
import { CheckInMethod, RegistrationSource } from '@prisma/client';
import { EncounterService } from '../encounters/encounter.service';
import { CheckInService } from '../check-in/checkin.service';
import { OpQueueService } from '../queue/op-queue.service';

export interface MirrorInput {
  source: RegistrationSource;
  doctorId: string;
  patientId?: string;
  mobile?: string;
  name?: string;
  /** The service DAY, YYYY-MM-DD (legacy sessionType is intentionally dropped —
   *  the new model has one OpSession per doctor per day). */
  serviceDate: string;
  /** Stable key so a retried channel call maps to the SAME encounter. For voice
   *  this is the callSid; for app/reception it is the legacy bookingId. */
  idempotencyKey: string;
  /** Legacy bookingId, stored in channelMeta so Task 5 backfill can correlate. */
  legacyBookingId?: string;
  actorId?: string;
  /**
   * Reception combined desk path only: the patient is physically present, so
   * also check in (AUTO), issue the token, and enqueue — the same primitives the
   * combined desk flow uses. Left false for app/voice, where the token is issued
   * later at desk check-in (registration ≠ token).
   */
  present?: boolean;
}

/**
 * Transitional dual-write bridge (Task 2). Each real channel (app/payments,
 * voice, reception) keeps writing its legacy Booking + legacy queue exactly as
 * before, and ALSO calls this to drive the NEW Encounter pipeline in parallel,
 * so the CQRS read models populate ahead of the Task 5 read cutover.
 *
 * BEST-EFFORT BY DESIGN: it never throws. The legacy path is still the source of
 * truth until cutover, so a missing TokenSeries / any engine hiccup must NOT
 * undo a real booking. Every step is idempotent (register by key, check-in and
 * enqueue by encounter), so retries and webhook races are safe. Retire this
 * bridge in Task 5 once new reads are verified.
 */
@Injectable()
export class OpMirrorService {
  private readonly logger = new Logger(OpMirrorService.name);

  constructor(
    private readonly encounters: EncounterService,
    private readonly checkIn: CheckInService,
    private readonly queue: OpQueueService,
  ) {}

  async mirror(input: MirrorInput): Promise<{ encounterId: string } | null> {
    try {
      const encounter = await this.encounters.register({
        source: input.source,
        doctorId: input.doctorId,
        patientId: input.patientId,
        mobile: input.mobile,
        name: input.name,
        serviceDate: input.serviceDate,
        actorId: input.actorId,
        idempotencyKey: input.idempotencyKey,
        channelMeta: input.legacyBookingId
          ? { legacyBookingId: input.legacyBookingId }
          : undefined,
      });

      if (input.present) {
        await this.checkIn.checkIn(encounter.id, CheckInMethod.AUTO, {
          checkedInBy: input.actorId,
          issueToken: true,
        });
        await this.queue.enqueue(encounter.id);
      }

      return { encounterId: encounter.id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `op-mirror skipped (${input.source}, legacyBooking=${input.legacyBookingId ?? 'n/a'}): ${msg}`,
      );
      return null;
    }
  }
}
