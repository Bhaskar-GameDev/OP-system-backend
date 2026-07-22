import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import {
  CheckInMethod,
  EncounterStatus,
  RegistrationSource,
  TokenResetPolicy,
} from '@prisma/client';
import { PrismaModule } from '../src/common/prisma/prisma.module';
import { RedisModule } from '../src/common/redis/redis.module';
import { EventStoreModule } from '../src/event-store/event-store.module';
import { StateMachineModule } from '../src/state-machine/state-machine.module';
import { EncountersModule } from '../src/encounters/encounters.module';
import { TokensModule } from '../src/tokens/tokens.module';
import { CheckInModule } from '../src/check-in/checkin.module';
import { EncounterService } from '../src/encounters/encounter.service';
import { CheckInService } from '../src/check-in/checkin.service';
import { TokenSeriesService } from '../src/tokens/token-series.service';
import { EventStoreService } from '../src/event-store/event-store.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RedisService } from '../src/common/redis/redis.service';
import { DomainEventType } from '../src/event-store/domain-event.types';

/**
 * Check-in (Phase 3) + Token engine (Phase 4).
 * Proves: token gated on check-in; configurable rendering; atomic sequence;
 * per-session reset scope; reception combined path.
 */
describe('Check-in gates the token; token engine is configurable', () => {
  let enc: EncounterService;
  let checkin: CheckInService;
  let tokens: TokenSeriesService;
  let events: EventStoreService;
  let prisma: PrismaService;
  let redis: RedisService;
  let moduleRef: TestingModule;

  const stamp = Date.now();
  const HOSPITAL = `tk-hosp-${stamp}`;
  const CLINIC = `tk-clinic-${stamp}`;
  const DOCTOR = `tk-doc-${stamp}`;
  const NORMAL = `tk-normal-${stamp}`;
  const SPECIAL = `tk-special-${stamp}`;
  const encounterIds: string[] = [];
  const mobiles: string[] = [];

  const register = async (mobile: string, seriesId?: string) => {
    const e = await enc.register({
      mobile,
      doctorId: DOCTOR,
      serviceDate: '2026-07-26',
      source: RegistrationSource.APP,
      opCategoryId: seriesId,
    });
    encounterIds.push(e.id);
    mobiles.push(mobile);
    return e;
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        RedisModule,
        EventStoreModule,
        StateMachineModule,
        EncountersModule,
        TokensModule,
        CheckInModule,
      ],
    }).compile();
    await moduleRef.init();
    enc = moduleRef.get(EncounterService);
    checkin = moduleRef.get(CheckInService);
    tokens = moduleRef.get(TokenSeriesService);
    events = moduleRef.get(EventStoreService);
    prisma = moduleRef.get(PrismaService);
    redis = moduleRef.get(RedisService);

    await prisma.hospital.create({ data: { id: HOSPITAL, name: 'TK Hosp' } });
    await prisma.clinic.create({
      data: { id: CLINIC, hospitalId: HOSPITAL, name: 'TK Clinic' },
    });
    await prisma.doctor.create({
      data: { id: DOCTOR, clinicId: CLINIC, name: 'TK Dr' },
    });
    await prisma.tokenSeries.createMany({
      data: [
        {
          id: NORMAL,
          clinicId: CLINIC,
          code: 'NORMAL_OP',
          label: 'Normal OP',
          prefix: 'N',
          padWidth: 3,
          startAt: 1,
          resetPolicy: TokenResetPolicy.PER_SESSION,
        },
        {
          id: SPECIAL,
          clinicId: CLINIC,
          code: 'SPECIAL_OP',
          label: 'Special OP',
          prefix: 'S',
          padWidth: 3,
          startAt: 101, // configurable start value
          resetPolicy: TokenResetPolicy.PER_SESSION,
        },
      ],
    });
  });

  afterAll(async () => {
    await redis.redis.del(
      `pfos:tokenseq:${NORMAL}:${DOCTOR}:2026-07-26`,
      `pfos:tokenseq:${SPECIAL}:${DOCTOR}:2026-07-26`,
    );
    await prisma.domainEvent.deleteMany({
      where: { streamId: { in: encounterIds } },
    });
    await prisma.token.deleteMany({
      where: { encounterId: { in: encounterIds } },
    });
    await prisma.checkIn.deleteMany({
      where: { encounterId: { in: encounterIds } },
    });
    await prisma.registration.deleteMany({
      where: { encounterId: { in: encounterIds } },
    });
    await prisma.encounter.deleteMany({ where: { id: { in: encounterIds } } });
    await prisma.patient.deleteMany({ where: { mobile: { in: mobiles } } });
    await prisma.tokenSeries.deleteMany({
      where: { id: { in: [NORMAL, SPECIAL] } },
    });
    await prisma.doctor.deleteMany({ where: { id: DOCTOR } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC } });
    await prisma.hospital.deleteMany({ where: { id: HOSPITAL } });
    await moduleRef.close(); // closes Redis + Prisma connections (no open handles)
  });

  it('REFUSES to issue a token before check-in (core rule §3)', async () => {
    const e = await register('6300000001');
    await expect(tokens.issueForEncounter(e.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // still no token
    expect(await prisma.token.findUnique({ where: { encounterId: e.id } })).toBeNull();
  });

  it('issues a token AFTER check-in, transitions to TOKEN_ISSUED, logs events', async () => {
    const e = await register('6300000002');
    await checkin.checkIn(e.id, CheckInMethod.DESK);
    const issued = await tokens.issueForEncounter(e.id);
    expect(issued.displayNumber).toMatch(/^N\d{3}$/);
    const after = await prisma.encounter.findUnique({ where: { id: e.id } });
    expect(after?.status).toBe(EncounterStatus.TOKEN_ISSUED);
    const stream = await events.loadStream('Encounter', e.id);
    expect(stream.map((s) => s.type)).toEqual([
      DomainEventType.EncounterCreated,
      DomainEventType.PatientCheckedIn,
      DomainEventType.TokenIssued,
    ]);
  });

  it('renders per series config — Special OP honours prefix S and startAt=101', async () => {
    const e = await register('6300000003', SPECIAL);
    await checkin.checkIn(e.id, CheckInMethod.DESK);
    const issued = await tokens.issueForEncounter(e.id);
    expect(issued.displayNumber).toBe('S101'); // startAt=101, first token
    expect(issued.sequence).toBe(101);
  });

  it('token issuance is idempotent per encounter', async () => {
    const e = await register('6300000004');
    await checkin.checkIn(e.id, CheckInMethod.DESK);
    const a = await tokens.issueForEncounter(e.id);
    const b = await tokens.issueForEncounter(e.id);
    expect(b.tokenId).toBe(a.tokenId);
    expect(b.displayNumber).toBe(a.displayNumber);
  });

  it('allocates contiguous numbers under concurrency (atomic INCR)', async () => {
    const es = await Promise.all(
      Array.from({ length: 6 }, (_, i) => register(`63001000${i + 10}`)),
    );
    await Promise.all(es.map((e) => checkin.checkIn(e.id, CheckInMethod.DESK)));
    const issued = await Promise.all(
      es.map((e) => tokens.issueForEncounter(e.id)),
    );
    const nums = issued.map((t) => t.sequence).sort((a, b) => a - b);
    // 6 distinct contiguous numbers, no gaps, no dupes (values depend on prior
    // tests sharing the NORMAL per-session counter — assert distinct+contiguous).
    const distinct = new Set(nums);
    expect(distinct.size).toBe(6);
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i] - nums[i - 1]).toBe(1);
    }
  });

  it('reception combined path: check-in + token in one call (AUTO)', async () => {
    const e = await register('6300000020');
    const result = await checkin.checkIn(e.id, CheckInMethod.AUTO, {
      checkedInBy: 'desk-1',
      issueToken: true,
    });
    expect(result.token).toBeDefined();
    expect(result.token!.displayNumber).toMatch(/^N\d{3}$/);
    expect(result.encounter.status).toBe(EncounterStatus.TOKEN_ISSUED);
  });
});
