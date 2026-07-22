import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import {
  BookingSource,
  BookingStatus,
  EncounterStatus,
  SessionType,
} from '@prisma/client';
import { PrismaModule } from '../src/common/prisma/prisma.module';
import { RedisModule } from '../src/common/redis/redis.module';
import { EventStoreModule } from '../src/event-store/event-store.module';
import { StateMachineModule } from '../src/state-machine/state-machine.module';
import { ReadSideModule } from '../src/read-side/read-side.module';
import { MigrationModule } from '../src/migration/migration.module';
import { BackfillService } from '../src/migration/backfill.service';
import { ProjectionRunner } from '../src/read-side/projection-runner.service';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * Task 5 cutover gate: backfill the legacy Booking god-rows into the new
 * aggregates, rebuild the CQRS read models from the event stream, and verify the
 * read side is correct BEFORE any legacy teardown. Partial module graph on
 * purpose (no live projection scheduler) so rebuild() is the only projector.
 */
describe('Backfill + rebuild produces correct read models (cutover gate)', () => {
  let moduleRef: TestingModule;
  let backfill: BackfillService;
  let projection: ProjectionRunner;
  let prisma: PrismaService;

  const stamp = Date.now();
  const HOSP = `bf-hosp-${stamp}`;
  const CLINIC = `bf-clinic-${stamp}`;
  const DOCTOR = `bf-doc-${stamp}`;
  const DATE = new Date('2026-09-10T00:00:00.000Z');

  // Legacy bookings spanning the status map: BOOKED->WAITING, ACTIVE->IN_CONSULTATION,
  // COMPLETED->COMPLETED, PENDING_PAYMENT->REGISTERED.
  const B_BOOKED = `bf-bk-booked-${stamp}`;
  const B_ACTIVE = `bf-bk-active-${stamp}`;
  const B_DONE = `bf-bk-done-${stamp}`;
  const B_PENDING = `bf-bk-pending-${stamp}`;
  const bookingIds = [B_BOOKED, B_ACTIVE, B_DONE, B_PENDING];
  const mobile = '7700000001';

  let encIds: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        RedisModule,
        EventStoreModule,
        StateMachineModule,
        ReadSideModule,
        MigrationModule,
      ],
    }).compile();
    await moduleRef.init();
    backfill = moduleRef.get(BackfillService);
    projection = moduleRef.get(ProjectionRunner);
    prisma = moduleRef.get(PrismaService);

    await cleanup();
    await prisma.hospital.create({ data: { id: HOSP, name: 'BF Hosp' } });
    await prisma.clinic.create({ data: { id: CLINIC, hospitalId: HOSP, name: 'BF Clinic' } });
    await prisma.doctor.create({ data: { id: DOCTOR, clinicId: CLINIC, name: 'BF Dr', avgConsultMinutes: 10 } });
    const patient = await prisma.patient.create({ data: { mobile, name: 'BF Patient' } });

    const base = {
      patientId: patient.id,
      doctorId: DOCTOR,
      source: BookingSource.APP,
      sessionDate: DATE,
      sessionType: SessionType.MORNING,
    };
    await prisma.booking.create({ data: { ...base, id: B_BOOKED, status: BookingStatus.BOOKED, tokenNumber: 'A001', checkedInAt: DATE } });
    await prisma.booking.create({ data: { ...base, id: B_ACTIVE, status: BookingStatus.ACTIVE, tokenNumber: 'A002', checkedInAt: DATE, consultationStartedAt: DATE } });
    await prisma.booking.create({ data: { ...base, id: B_DONE, status: BookingStatus.COMPLETED, tokenNumber: 'A003', checkedInAt: DATE, consultationStartedAt: DATE, consultationEndedAt: DATE } });
    await prisma.booking.create({ data: { ...base, id: B_PENDING, status: BookingStatus.PENDING_PAYMENT, tokenNumber: null } });
  });

  afterAll(async () => {
    await cleanup();
    await moduleRef.close();
  });

  async function cleanup(): Promise<void> {
    const encs = await prisma.encounter.findMany({ where: { legacyBookingId: { in: bookingIds } }, select: { id: true } }).catch(() => [] as { id: string }[]);
    encIds = encs.map((e) => e.id);
    const w = { encounterId: { in: encIds } };
    await prisma.queueEntry.deleteMany({ where: w }).catch(() => {});
    await prisma.token.deleteMany({ where: w }).catch(() => {});
    await prisma.checkIn.deleteMany({ where: w }).catch(() => {});
    await prisma.consultation.deleteMany({ where: w }).catch(() => {});
    await prisma.registration.deleteMany({ where: w }).catch(() => {});
    await prisma.queueReadModel.deleteMany({ where: w }).catch(() => {});
    await prisma.domainEvent.deleteMany({ where: { streamId: { in: encIds } } }).catch(() => {});
    await prisma.encounter.deleteMany({ where: { legacyBookingId: { in: bookingIds } } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } }).catch(() => {});
    await prisma.patient.deleteMany({ where: { mobile } }).catch(() => {});
    // The backfill get-or-creates a default NORMAL_OP series for the clinic.
    await prisma.tokenSeries.deleteMany({ where: { clinicId: CLINIC } }).catch(() => {});
    await prisma.doctor.deleteMany({ where: { id: DOCTOR } }).catch(() => {});
    await prisma.clinic.deleteMany({ where: { id: CLINIC } }).catch(() => {});
    await prisma.hospital.deleteMany({ where: { id: HOSP } }).catch(() => {});
  }

  async function encFor(bookingId: string) {
    return prisma.encounter.findUniqueOrThrow({ where: { legacyBookingId: bookingId } });
  }

  it('projects each legacy Booking into an Encounter with the mapped status', async () => {
    const res = await backfill.run();
    expect(res.migrated).toBeGreaterThanOrEqual(4);

    expect((await encFor(B_BOOKED)).status).toBe(EncounterStatus.WAITING);
    expect((await encFor(B_ACTIVE)).status).toBe(EncounterStatus.IN_CONSULTATION);
    expect((await encFor(B_DONE)).status).toBe(EncounterStatus.COMPLETED);
    expect((await encFor(B_PENDING)).status).toBe(EncounterStatus.REGISTERED);

    // token + check-in + consultation carried across where present
    const booked = await encFor(B_BOOKED);
    expect(await prisma.token.findUnique({ where: { encounterId: booked.id } })).not.toBeNull();
    expect(await prisma.checkIn.findUnique({ where: { encounterId: booked.id } })).not.toBeNull();
    const done = await encFor(B_DONE);
    expect(await prisma.consultation.findFirst({ where: { encounterId: done.id } })).not.toBeNull();
  });

  it('is idempotent — a second run skips already-migrated bookings', async () => {
    const before = await prisma.encounter.count({ where: { legacyBookingId: { in: bookingIds } } });
    const res = await backfill.run();
    const after = await prisma.encounter.count({ where: { legacyBookingId: { in: bookingIds } } });
    expect(after).toBe(before); // no duplicates
    // our four are counted as skipped this time
    expect(res.skipped).toBeGreaterThanOrEqual(4);
  });

  it('rebuild() produces read models for the migrated encounters', async () => {
    const mine = await prisma.encounter.findMany({
      where: { legacyBookingId: { in: bookingIds } },
      select: { id: true },
    });
    const ids = mine.map((e) => e.id);
    expect(ids.length).toBe(bookingIds.length);

    await projection.rebuild(); // drop + replay the whole event stream

    const booked = await encFor(B_BOOKED);
    const rm = await prisma.queueReadModel.findUnique({ where: { encounterId: booked.id } });
    expect(rm).not.toBeNull();
    expect(rm?.patientName).toBe('BF Patient');
    expect(rm?.clinicId).toBe(CLINIC);
    // every migrated encounter is represented in the read model
    const count = await prisma.queueReadModel.count({ where: { encounterId: { in: ids } } });
    expect(count).toBe(ids.length);
  });
});
