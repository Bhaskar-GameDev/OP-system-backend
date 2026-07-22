import { Test } from '@nestjs/testing';
import { EncounterStatus, RegistrationSource } from '@prisma/client';
import { PrismaModule } from '../src/common/prisma/prisma.module';
import { EventStoreModule } from '../src/event-store/event-store.module';
import { StateMachineModule } from '../src/state-machine/state-machine.module';
import { EncountersModule } from '../src/encounters/encounters.module';
import { EncounterService } from '../src/encounters/encounter.service';
import { EventStoreService } from '../src/event-store/event-store.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { DomainEventType } from '../src/event-store/domain-event.types';

/**
 * Registration pipeline (Phase 2). Proves the architectural invariant: all three
 * sources produce an IDENTICAL Encounter, `source` is analytics-only, and
 * registration never issues a token or a queue entry.
 */
describe('Registration pipeline — unified across sources', () => {
  let svc: EncounterService;
  let events: EventStoreService;
  let prisma: PrismaService;

  const CLINIC = `reg-clinic-${Date.now()}`;
  const HOSPITAL = `reg-hosp-${Date.now()}`;
  const DOCTOR = `reg-doc-${Date.now()}`;
  const SERIES = `reg-series-${Date.now()}`;
  const encounterIds: string[] = [];
  const patientMobiles = ['6200000001', '6200000002', '6200000003'];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        EventStoreModule,
        StateMachineModule,
        EncountersModule,
      ],
    }).compile();
    await moduleRef.init();
    svc = moduleRef.get(EncounterService);
    events = moduleRef.get(EventStoreService);
    prisma = moduleRef.get(PrismaService);

    await prisma.hospital.create({ data: { id: HOSPITAL, name: 'Reg Hosp' } });
    await prisma.clinic.create({
      data: { id: CLINIC, hospitalId: HOSPITAL, name: 'Reg Clinic' },
    });
    await prisma.doctor.create({
      data: { id: DOCTOR, clinicId: CLINIC, name: 'Reg Dr' },
    });
    await prisma.tokenSeries.create({
      data: {
        id: SERIES,
        clinicId: CLINIC,
        code: 'NORMAL_OP',
        label: 'Normal OP',
        prefix: 'N',
      },
    });
  });

  afterAll(async () => {
    await prisma.domainEvent.deleteMany({
      where: { streamId: { in: encounterIds } },
    });
    await prisma.registration.deleteMany({
      where: { encounterId: { in: encounterIds } },
    });
    await prisma.encounter.deleteMany({
      where: { id: { in: encounterIds } },
    });
    await prisma.patient.deleteMany({
      where: { mobile: { in: patientMobiles } },
    });
    await prisma.tokenSeries.deleteMany({ where: { id: SERIES } });
    await prisma.doctor.deleteMany({ where: { id: DOCTOR } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC } });
    await prisma.hospital.deleteMany({ where: { id: HOSPITAL } });
    await prisma.$disconnect();
  });

  const sources: RegistrationSource[] = [
    RegistrationSource.APP,
    RegistrationSource.VOICE_AGENT,
    RegistrationSource.RECEPTION,
  ];

  it.each(sources)(
    'source %s creates an identical REGISTERED encounter (no token, no queue)',
    async (source) => {
      const i = sources.indexOf(source);
      const enc = await svc.register({
        mobile: patientMobiles[i],
        name: `P${i}`,
        doctorId: DOCTOR,
        serviceDate: '2026-07-25',
        source,
      });
      encounterIds.push(enc.id);

      // Same Encounter shape regardless of source.
      expect(enc.status).toBe(EncounterStatus.REGISTERED);
      expect(enc.doctorId).toBe(DOCTOR);
      expect(enc.clinicId).toBe(CLINIC);
      expect(enc.hospitalId).toBe(HOSPITAL);
      expect(enc.opCategoryId).toBe(SERIES);

      // No token, no queue entry on registration.
      expect(await prisma.token.findUnique({ where: { encounterId: enc.id } })).toBeNull();
      expect(
        await prisma.queueEntry.findUnique({ where: { encounterId: enc.id } }),
      ).toBeNull();

      // Source is recorded ONLY on the Registration row.
      const reg = await prisma.registration.findUnique({
        where: { encounterId: enc.id },
      });
      expect(reg?.source).toBe(source);

      // The encounter column carries NO source field at all (queue can't see it).
      expect((enc as Record<string, unknown>).source).toBeUndefined();
    },
  );

  it('emits exactly one EncounterCreated event at version 1', async () => {
    const enc = await svc.register({
      mobile: '6200000009',
      doctorId: DOCTOR,
      serviceDate: '2026-07-25',
      source: RegistrationSource.APP,
    });
    encounterIds.push(enc.id);
    patientMobiles.push('6200000009');
    const stream = await events.loadStream('Encounter', enc.id);
    expect(stream).toHaveLength(1);
    expect(stream[0].type).toBe(DomainEventType.EncounterCreated);
    expect(stream[0].version).toBe(1);
    // source present in metadata (analytics) — not in payload used by the engine
    expect(stream[0].metadata?.source).toBe(RegistrationSource.APP);
  });

  it('is idempotent for a retried voice call (same idempotencyKey => same encounter)', async () => {
    const key = `callsid-${Date.now()}`;
    const first = await svc.register({
      mobile: '6200000010',
      doctorId: DOCTOR,
      serviceDate: '2026-07-25',
      source: RegistrationSource.VOICE_AGENT,
      idempotencyKey: key,
      channelMeta: { callSid: key },
    });
    const second = await svc.register({
      mobile: '6200000010',
      doctorId: DOCTOR,
      serviceDate: '2026-07-25',
      source: RegistrationSource.VOICE_AGENT,
      idempotencyKey: key,
    });
    encounterIds.push(first.id);
    patientMobiles.push('6200000010');
    expect(second.id).toBe(first.id); // no second token, no duplicate
    const regs = await prisma.registration.findMany({
      where: { encounterId: first.id },
    });
    expect(regs).toHaveLength(1);
  });

  it('arrive() moves REGISTERED -> ARRIVED and logs PatientArrived', async () => {
    const enc = await svc.register({
      mobile: '6200000011',
      doctorId: DOCTOR,
      serviceDate: '2026-07-25',
      source: RegistrationSource.APP,
    });
    encounterIds.push(enc.id);
    patientMobiles.push('6200000011');
    const arrived = await svc.arrive(enc.id);
    expect(arrived.status).toBe(EncounterStatus.ARRIVED);
    const stream = await events.loadStream('Encounter', enc.id);
    expect(stream.map((e) => e.type)).toEqual([
      DomainEventType.EncounterCreated,
      DomainEventType.PatientArrived,
    ]);
  });
});
