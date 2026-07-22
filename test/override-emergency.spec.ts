import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import {
  CheckInMethod,
  ConsultationState,
  EncounterStatus,
  OverrideReason,
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
import { OpQueueModule } from '../src/queue/op-queue.module';
import { ConsultationModule } from '../src/consultation/consultation.module';
import { OverrideModule } from '../src/override/override.module';
import { EncounterService } from '../src/encounters/encounter.service';
import { CheckInService } from '../src/check-in/checkin.service';
import { OpQueueService } from '../src/queue/op-queue.service';
import { ConsultationEngineService } from '../src/consultation/consultation-engine.service';
import { DoctorOverrideService } from '../src/override/doctor-override.service';
import { EmergencyService } from '../src/override/emergency.service';
import { EventStoreService } from '../src/event-store/event-store.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RedisService } from '../src/common/redis/redis.service';
import { DomainEventType } from '../src/event-store/domain-event.types';

describe('Doctor Override (§7) + Emergency interruption (§8)', () => {
  let enc: EncounterService;
  let checkin: CheckInService;
  let queue: OpQueueService;
  let engine: ConsultationEngineService;
  let override: DoctorOverrideService;
  let emergency: EmergencyService;
  let events: EventStoreService;
  let prisma: PrismaService;
  let redis: RedisService;
  let moduleRef: TestingModule;

  const stamp = Date.now();
  const HOSPITAL = `o-hosp-${stamp}`;
  const CLINIC = `o-clinic-${stamp}`;
  const NORMAL = `o-normal-${stamp}`;
  const mobiles: string[] = [];
  let seq = 0;

  const makeDoctor = async (id: string) => {
    await prisma.doctor.create({ data: { id, clinicId: CLINIC, name: id } });
    return id;
  };

  const admit = async (doctorId: string) => {
    const mobile = `66${String(stamp).slice(-6)}${String(seq++).padStart(2, '0')}`;
    mobiles.push(mobile);
    const e = await enc.register({
      mobile,
      doctorId,
      serviceDate: '2026-07-29',
      source: RegistrationSource.APP,
      opCategoryId: NORMAL,
    });
    await checkin.checkIn(e.id, CheckInMethod.DESK, { issueToken: true });
    const token = await prisma.token.findUnique({ where: { encounterId: e.id } });
    const r = await queue.enqueue(e.id);
    return { encounterId: e.id, sessionId: r.opSessionId, token: token!.displayNumber };
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
        OpQueueModule,
        ConsultationModule,
        OverrideModule,
      ],
    }).compile();
    await moduleRef.init();
    enc = moduleRef.get(EncounterService);
    checkin = moduleRef.get(CheckInService);
    queue = moduleRef.get(OpQueueService);
    engine = moduleRef.get(ConsultationEngineService);
    override = moduleRef.get(DoctorOverrideService);
    emergency = moduleRef.get(EmergencyService);
    events = moduleRef.get(EventStoreService);
    prisma = moduleRef.get(PrismaService);
    redis = moduleRef.get(RedisService);

    await prisma.hospital.create({ data: { id: HOSPITAL, name: 'O Hosp' } });
    await prisma.clinic.create({
      data: { id: CLINIC, hospitalId: HOSPITAL, name: 'O Clinic' },
    });
    await prisma.tokenSeries.create({
      data: {
        id: NORMAL,
        clinicId: CLINIC,
        code: 'NORMAL_OP',
        label: 'Normal',
        prefix: 'N',
        resetPolicy: TokenResetPolicy.PER_SESSION,
      },
    });
  });

  afterAll(async () => {
    const docs = (await prisma.doctor.findMany({ where: { clinicId: CLINIC }, select: { id: true } })).map((d) => d.id);
    const keys = await redis.redis.keys('pfos:q:*');
    const mine = keys.filter((k) => docs.some((d) => k.includes(d)));
    if (mine.length) await redis.redis.del(...mine);
    const allEnc = (await prisma.encounter.findMany({ where: { clinicId: CLINIC }, select: { id: true } })).map((e) => e.id);
    const allCon = (await prisma.consultation.findMany({ where: { encounterId: { in: allEnc } }, select: { id: true } })).map((c) => c.id);
    await prisma.domainEvent.deleteMany({ where: { streamId: { in: [...allEnc, ...allCon] } } });
    await prisma.consultation.deleteMany({ where: { encounterId: { in: allEnc } } });
    await prisma.queueEntry.deleteMany({ where: { encounterId: { in: allEnc } } });
    await prisma.token.deleteMany({ where: { encounterId: { in: allEnc } } });
    await prisma.checkIn.deleteMany({ where: { encounterId: { in: allEnc } } });
    await prisma.registration.deleteMany({ where: { encounterId: { in: allEnc } } });
    await prisma.encounter.deleteMany({ where: { clinicId: CLINIC } });
    await prisma.opSession.deleteMany({ where: { clinicId: CLINIC } });
    await prisma.patient.deleteMany({ where: { mobile: { in: mobiles } } });
    await prisma.tokenSeries.deleteMany({ where: { clinicId: CLINIC } });
    await prisma.doctor.deleteMany({ where: { clinicId: CLINIC } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC } });
    await prisma.hospital.deleteMany({ where: { id: HOSPITAL } });
    await moduleRef.close();
  });

  it('override consults now WITHOUT a token and WITHOUT renumbering the queue', async () => {
    const doc = await makeDoctor(`o-doc-ovr-${stamp}`);
    const a = await admit(doc); // N001
    const b = await admit(doc); // N002
    const queueBefore = await queue.listWaiting(a.sessionId);
    const orderBefore = queueBefore.map((q) => q.encounterId);

    const vip = await override.start({
      doctorId: doc,
      mobile: `66999${String(stamp).slice(-5)}`,
      name: 'VIP',
      serviceDate: '2026-07-29',
      reason: OverrideReason.VIP,
    });
    mobiles.push(`66999${String(stamp).slice(-5)}`);

    // VIP is consulting now, has NO token, is NOT in the queue.
    expect(vip.encounter.status).toBe(EncounterStatus.IN_CONSULTATION);
    expect(vip.encounter.override).toBe(true);
    expect(await prisma.token.findUnique({ where: { encounterId: vip.encounter.id } })).toBeNull();
    expect(await prisma.queueEntry.findUnique({ where: { encounterId: vip.encounter.id } })).toBeNull();

    // The waiting queue is UNCHANGED — same members, same order, same tokens.
    const queueAfter = await queue.listWaiting(a.sessionId);
    expect(queueAfter.map((q) => q.encounterId)).toEqual(orderBefore);
    const tA = await prisma.token.findUnique({ where: { encounterId: a.encounterId } });
    const tB = await prisma.token.findUnique({ where: { encounterId: b.encounterId } });
    expect(tA?.displayNumber).toBe(a.token); // not renumbered
    expect(tB?.displayNumber).toBe(b.token);

    // Audit
    const stream = await events.loadStream('Encounter', vip.encounter.id);
    expect(stream.map((s) => s.type)).toContain(DomainEventType.DoctorOverrideStarted);

    // Resume queue: next Call Next continues with the waiting patients.
    await override.complete(vip.encounter.id);
    const next = await engine.callNext(a.sessionId);
    expect(next?.encounter.id).toBe(a.encounterId);
  });

  it('override blocked while a normal consultation is active (one-active rule)', async () => {
    const doc = await makeDoctor(`o-doc-block-${stamp}`);
    const a = await admit(doc);
    await engine.callNext(a.sessionId);
    await engine.startConsultation(a.encounterId);
    await expect(
      override.start({
        doctorId: doc,
        mobile: `66888${String(stamp).slice(-5)}`,
        serviceDate: '2026-07-29',
        reason: OverrideReason.MANAGEMENT,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    mobiles.push(`66888${String(stamp).slice(-5)}`);
  });

  it('emergency pauses the active consultation and auto-resumes it after', async () => {
    const doc = await makeDoctor(`o-doc-emg-${stamp}`);
    const a = await admit(doc);
    const b = await admit(doc); // stays waiting throughout
    await engine.callNext(a.sessionId);
    const activeConsult = await engine.startConsultation(a.encounterId);

    const queueBefore = (await queue.listWaiting(a.sessionId)).map((q) => q.encounterId);

    const em = await emergency.start({
      doctorId: doc,
      mobile: `66777${String(stamp).slice(-5)}`,
      name: 'Emergency',
      serviceDate: '2026-07-29',
    });
    mobiles.push(`66777${String(stamp).slice(-5)}`);

    // Original consultation paused; original encounter PAUSED; emergency ACTIVE.
    const pausedConsult = await prisma.consultation.findUnique({ where: { id: activeConsult.id } });
    expect(pausedConsult?.state).toBe(ConsultationState.PAUSED);
    const pausedEnc = await prisma.encounter.findUnique({ where: { id: a.encounterId } });
    expect(pausedEnc?.status).toBe(EncounterStatus.PAUSED);
    expect(em.emergencyConsultation.state).toBe(ConsultationState.ACTIVE);

    // Queue untouched by the emergency.
    expect((await queue.listWaiting(a.sessionId)).map((q) => q.encounterId)).toEqual(queueBefore);

    // End emergency -> original auto-resumes.
    const { resumedConsultationId } = await emergency.end(em.emergencyConsultation.id);
    expect(resumedConsultationId).toBe(activeConsult.id);
    const resumed = await prisma.consultation.findUnique({ where: { id: activeConsult.id } });
    expect(resumed?.state).toBe(ConsultationState.ACTIVE);
    const resumedEnc = await prisma.encounter.findUnique({ where: { id: a.encounterId } });
    expect(resumedEnc?.status).toBe(EncounterStatus.IN_CONSULTATION);

    // Emergency consultation stream: started -> completed; encounter carries EmergencyStarted/Ended.
    const emEncStream = await events.loadStream('Encounter', em.emergencyEncounter.id);
    expect(emEncStream.map((s) => s.type)).toEqual(
      expect.arrayContaining([
        DomainEventType.EmergencyStarted,
        DomainEventType.EmergencyEnded,
      ]),
    );
    void b;
  });
});
