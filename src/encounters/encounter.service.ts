import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Encounter,
  EncounterStatus,
  Prisma,
  RegistrationReason,
  RegistrationSource,
} from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { EventStoreService } from '../event-store/event-store.service';
import { DomainEventType } from '../event-store/domain-event.types';
import { StateMachineService } from '../state-machine/state-machine.service';
import { RegisterEncounterDto } from './encounter.dto';

/**
 * Registration pipeline (ARCHITECTURE.md §4, Phase 2).
 *
 * ONE method serves all three sources. The ONLY per-source difference is the
 * `Registration.source` value + `channelMeta`. Registration records intent:
 *  - it NEVER issues a token,
 *  - it NEVER enqueues.
 * The Encounter is created in status REGISTERED and waits for an explicit
 * check-in (Phase 3) — except the reception combined path, handled there.
 */
@Injectable()
export class EncounterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventStoreService,
    private readonly sm: StateMachineService,
  ) {}

  /** Create an Encounter + its Registration atomically, and emit EncounterCreated. */
  async register(dto: RegisterEncounterDto): Promise<Encounter> {
    // Idempotency: a retried voice call (same key) returns the existing encounter.
    if (dto.idempotencyKey) {
      const existing = await this.findByIdempotencyKey(
        dto.source,
        dto.idempotencyKey,
      );
      if (existing) return existing;
    }

    // Resolve tenant from the doctor (single source of truth for clinic/hospital).
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: dto.doctorId },
      select: { id: true, clinicId: true },
    });
    if (!doctor) throw new NotFoundException('doctor not found');
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: doctor.clinicId },
      select: { id: true, hospitalId: true },
    });
    if (!clinic) throw new NotFoundException('clinic not found');

    const patientId = await this.resolvePatient(dto);
    const opCategoryId = await this.resolveSeries(clinic.id, dto.opCategoryId);
    const serviceDate = this.toDate(dto.serviceDate);

    return this.prisma.$transaction(async (tx) => {
      const encounter = await tx.encounter.create({
        data: {
          patientId,
          hospitalId: clinic.hospitalId,
          clinicId: clinic.id,
          doctorId: doctor.id,
          departmentId: dto.departmentId ?? null,
          serviceDate,
          registrationReason: dto.reason ?? RegistrationReason.NEW,
          opCategoryId,
          status: EncounterStatus.REGISTERED,
        },
      });

      await tx.registration.create({
        data: {
          encounterId: encounter.id,
          source: dto.source,
          actorId: dto.actorId ?? null,
          channelMeta: this.buildChannelMeta(dto),
        },
      });

      // Event log is the source of truth. EncounterCreated opens the stream (v1).
      await this.events.append(
        {
          streamType: 'Encounter',
          streamId: encounter.id,
          type: DomainEventType.EncounterCreated,
          payload: {
            patientId,
            doctorId: doctor.id,
            clinicId: clinic.id,
            serviceDate: serviceDate.toISOString().slice(0, 10),
            reason: encounter.registrationReason,
            opCategoryId,
          },
          // source is METADATA only — it is audit/analytics, never queue input.
          metadata: {
            actorId: dto.actorId,
            clinicId: clinic.id,
            source: dto.source,
          },
        },
        0,
        tx,
      );

      return encounter;
    });
  }

  /** Optional pre-check-in arrival marker (REGISTERED -> ARRIVED). */
  async arrive(encounterId: string, actorId?: string): Promise<Encounter> {
    const enc = await this.mustGet(encounterId);
    const next = this.sm.nextEncounter(enc.status, 'ARRIVE');
    return this.prisma.$transaction(async (tx) => {
      const version = await this.events.currentVersion(
        'Encounter',
        enc.id,
        tx,
      );
      const updated = await tx.encounter.update({
        where: { id: enc.id },
        data: { status: next },
      });
      await this.events.append(
        {
          streamType: 'Encounter',
          streamId: enc.id,
          type: DomainEventType.PatientArrived,
          payload: {},
          metadata: { actorId, clinicId: enc.clinicId },
        },
        version,
        tx,
      );
      return updated;
    });
  }

  async get(encounterId: string): Promise<Encounter | null> {
    return this.prisma.encounter.findUnique({ where: { id: encounterId } });
  }

  private async mustGet(encounterId: string): Promise<Encounter> {
    const enc = await this.get(encounterId);
    if (!enc) throw new NotFoundException('encounter not found');
    return enc;
  }

  // ── helpers ────────────────────────────────────────────

  private async findByIdempotencyKey(
    source: RegistrationSource,
    key: string,
  ): Promise<Encounter | null> {
    const reg = await this.prisma.registration.findFirst({
      where: {
        source,
        channelMeta: {
          path: ['idempotencyKey'],
          equals: key,
        },
      },
      select: { encounterId: true },
    });
    if (!reg) return null;
    return this.prisma.encounter.findUnique({
      where: { id: reg.encounterId },
    });
  }

  /** Existing patientId wins; otherwise upsert by mobile (cross-tenant patient). */
  private async resolvePatient(dto: RegisterEncounterDto): Promise<string> {
    if (dto.patientId) {
      const p = await this.prisma.patient.findUnique({
        where: { id: dto.patientId },
        select: { id: true },
      });
      if (!p) throw new NotFoundException('patient not found');
      return p.id;
    }
    if (!dto.mobile) {
      throw new BadRequestException('patientId or mobile is required');
    }
    const existing = await this.prisma.patient.findUnique({
      where: { mobile: dto.mobile },
      select: { id: true },
    });
    if (existing) return existing.id;
    const created = await this.prisma.patient.create({
      data: { mobile: dto.mobile, name: dto.name ?? 'Patient' },
      select: { id: true },
    });
    return created.id;
  }

  /**
   * Resolve the OP category (TokenSeries) for the clinic. Explicit id is
   * validated to belong to the clinic; otherwise the clinic default is used
   * (prefers code NORMAL_OP, else the first active series). Zero hardcoding.
   */
  private async resolveSeries(
    clinicId: string,
    opCategoryId?: string,
  ): Promise<string> {
    if (opCategoryId) {
      const s = await this.prisma.tokenSeries.findUnique({
        where: { id: opCategoryId },
        select: { id: true, clinicId: true, active: true },
      });
      if (!s || s.clinicId !== clinicId) {
        throw new BadRequestException('token series not in this clinic');
      }
      if (!s.active) throw new BadRequestException('token series inactive');
      return s.id;
    }
    const series = await this.prisma.tokenSeries.findMany({
      where: { clinicId, active: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true, code: true },
    });
    if (series.length === 0) {
      throw new BadRequestException(
        'no token series configured for this clinic',
      );
    }
    return (series.find((s) => s.code === 'NORMAL_OP') ?? series[0]).id;
  }

  private buildChannelMeta(
    dto: RegisterEncounterDto,
  ): Prisma.InputJsonValue | undefined {
    const meta: Record<string, unknown> = { ...(dto.channelMeta ?? {}) };
    if (dto.idempotencyKey) meta.idempotencyKey = dto.idempotencyKey;
    return Object.keys(meta).length
      ? (meta as Prisma.InputJsonValue)
      : undefined;
  }

  private toDate(iso: string): Date {
    // Normalize to a date-only value at UTC midnight (serviceDate is @db.Date).
    return new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
  }
}
