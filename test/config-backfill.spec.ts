import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import {
  BookingSource,
  BookingStatus,
  EncounterStatus,
  RegistrationSource,
  SessionType,
} from '@prisma/client';
import { PrismaModule } from '../src/common/prisma/prisma.module';
import { EventStoreModule } from '../src/event-store/event-store.module';
import { StateMachineModule } from '../src/state-machine/state-machine.module';
import { ConfigEngineModule } from '../src/config-engine/config-engine.module';
import { MigrationModule } from '../src/migration/migration.module';
import { OpConfigService } from '../src/config-engine/op-config.service';
import { BackfillService } from '../src/migration/backfill.service';
import { PrismaService } from '../src/common/prisma/prisma.service';

/** Config engine (Phase 11) + legacy backfill (Phase 15). */
describe('Config engine + legacy backfill', () => {
  let config: OpConfigService;
  let backfill: BackfillService;
  let prisma: PrismaService;
  let moduleRef: TestingModule;

  const stamp = Date.now();
  const HOSPITAL = `x-hosp-${stamp}`;
  const CLINIC = `x-clinic-${stamp}`;
  const DOCTOR = `x-doc-${stamp}`;
  const PATIENT = `x-pat-${stamp}`;
  const BOOKING = `x-booking-${stamp}`;
  const mobile = `69${String(stamp).slice(-8)}`;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        EventStoreModule,
        StateMachineModule,
        ConfigEngineModule,
        MigrationModule,
      ],
    }).compile();
    await moduleRef.init();
    config = moduleRef.get(OpConfigService);
    backfill = moduleRef.get(BackfillService);
    prisma = moduleRef.get(PrismaService);

    await prisma.hospital.create({ data: { id: HOSPITAL, name: 'X Hosp' } });
    await prisma.clinic.create({
      data: { id: CLINIC, hospitalId: HOSPITAL, name: 'X Clinic' },
    });
    await prisma.doctor.create({
      data: { id: DOCTOR, clinicId: CLINIC, name: 'X Dr' },
    });
    await prisma.patient.create({
      data: { id: PATIENT, name: 'Legacy Pt', mobile },
    });
  });

  afterAll(async () => {
    const enc = await prisma.encounter.findFirst({
      where: { legacyBookingId: BOOKING },
      select: { id: true },
    });
    if (enc) {
      await prisma.domainEvent.deleteMany({ where: { streamId: enc.id } });
      await prisma.consultation.deleteMany({ where: { encounterId: enc.id } });
      await prisma.token.deleteMany({ where: { encounterId: enc.id } });
      await prisma.checkIn.deleteMany({ where: { encounterId: enc.id } });
      await prisma.registration.deleteMany({ where: { encounterId: enc.id } });
      await prisma.encounter.deleteMany({ where: { id: enc.id } });
    }
    await prisma.domainEvent.deleteMany({
      where: { streamId: { startsWith: `CLINIC:${CLINIC}` } },
    });
    await prisma.domainEvent.deleteMany({
      where: { streamId: { startsWith: `DOCTOR:${DOCTOR}` } },
    });
    await prisma.hospitalConfig.deleteMany({
      where: { scopeId: { in: [HOSPITAL, CLINIC, DOCTOR] } },
    });
    await prisma.booking.deleteMany({ where: { id: BOOKING } });
    await prisma.tokenSeries.deleteMany({ where: { clinicId: CLINIC } });
    await prisma.patient.deleteMany({ where: { id: PATIENT } });
    await prisma.doctor.deleteMany({ where: { id: DOCTOR } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC } });
    await prisma.hospital.deleteMany({ where: { id: HOSPITAL } });
    await moduleRef.close();
  });

  it('resolves config most-specific-first: DOCTOR > CLINIC > HOSPITAL > default', async () => {
    const key = 'checkin.autoIssueToken';
    const scope = { hospitalId: HOSPITAL, clinicId: CLINIC, doctorId: DOCTOR };
    expect(await config.get(key, scope, false)).toBe(false); // default
    await config.set('HOSPITAL', HOSPITAL, key, true);
    expect(await config.get(key, scope, false)).toBe(true); // hospital
    await config.set('CLINIC', CLINIC, key, false);
    expect(await config.get(key, scope, true)).toBe(false); // clinic overrides hospital
    await config.set('DOCTOR', DOCTOR, key, true);
    expect(await config.get(key, scope, false)).toBe(true); // doctor overrides clinic
    // typed helper reads the same key
    expect(await config.checkInAutoIssueToken(scope)).toBe(true);
  });

  it('emits ConfigChanged on every set (event-sourced config)', async () => {
    await config.set('CLINIC', CLINIC, 'clinic.workingHours', {
      open: '08:00',
      close: '22:00',
    });
    const hours = await config.workingHours({ clinicId: CLINIC });
    expect(hours).toEqual({ open: '08:00', close: '22:00' });
    const stream = await prisma.domainEvent.findMany({
      where: { streamType: 'Config', streamId: `CLINIC:${CLINIC}` },
    });
    expect(stream.length).toBeGreaterThan(0);
    expect(stream.every((e) => e.type === 'ConfigChanged')).toBe(true);
  });

  it('backfills a legacy Booking into the separated aggregates, idempotently', async () => {
    await prisma.booking.create({
      data: {
        id: BOOKING,
        patientId: PATIENT,
        doctorId: DOCTOR,
        source: BookingSource.WALK_IN,
        tokenNumber: 'W007',
        sessionDate: new Date('2026-07-20T00:00:00Z'),
        sessionType: SessionType.MORNING,
        status: BookingStatus.COMPLETED,
        checkedInAt: new Date('2026-07-20T04:00:00Z'),
        consultationStartedAt: new Date('2026-07-20T04:10:00Z'),
        consultationEndedAt: new Date('2026-07-20T04:20:00Z'),
      },
    });

    const first = await backfill.run();
    expect(first.migrated).toBeGreaterThanOrEqual(1);

    const enc = await prisma.encounter.findFirst({
      where: { legacyBookingId: BOOKING },
    });
    expect(enc).not.toBeNull();
    expect(enc?.status).toBe(EncounterStatus.COMPLETED);

    // Registration source mapped WALK_IN -> RECEPTION (analytics only).
    const reg = await prisma.registration.findUnique({
      where: { encounterId: enc!.id },
    });
    expect(reg?.source).toBe(RegistrationSource.RECEPTION);

    // Aggregates populated from the god-row.
    expect(await prisma.checkIn.findUnique({ where: { encounterId: enc!.id } })).not.toBeNull();
    const token = await prisma.token.findUnique({ where: { encounterId: enc!.id } });
    expect(token?.displayNumber).toBe('W007');
    expect(await prisma.consultation.findFirst({ where: { encounterId: enc!.id } })).not.toBeNull();

    // Idempotent: a second run skips the already-migrated booking.
    const second = await backfill.run();
    expect(second.skipped).toBeGreaterThanOrEqual(1);
    const encCount = await prisma.encounter.count({
      where: { legacyBookingId: BOOKING },
    });
    expect(encCount).toBe(1);
  });
});
