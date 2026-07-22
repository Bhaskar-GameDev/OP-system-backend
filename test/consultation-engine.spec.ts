import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import {
  CheckInMethod,
  ConsultationState,
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
import { OpQueueModule } from '../src/queue/op-queue.module';
import { ConsultationModule } from '../src/consultation/consultation.module';
import { EncounterService } from '../src/encounters/encounter.service';
import { CheckInService } from '../src/check-in/checkin.service';
import { OpQueueService } from '../src/queue/op-queue.service';
import { ConsultationEngineService } from '../src/consultation/consultation-engine.service';
import { EventStoreService } from '../src/event-store/event-store.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RedisService } from '../src/common/redis/redis.service';
import { DomainEventType } from '../src/event-store/domain-event.types';

/** Consultation engine (Phase 7): call/start/skip/recall/no-show/complete/transfer. */
describe('Consultation engine — doctor controls', () => {
  let enc: EncounterService;
  let checkin: CheckInService;
  let queue: OpQueueService;
  let engine: ConsultationEngineService;
  let events: EventStoreService;
  let prisma: PrismaService;
  let redis: RedisService;
  let moduleRef: TestingModule;

  const stamp = Date.now();
  const HOSPITAL = `c-hosp-${stamp}`;
  const CLINIC = `c-clinic-${stamp}`;
  const NORMAL = `c-normal-${stamp}`;
  const encounterIds: string[] = [];
  const mobiles: string[] = [];
  let seq = 0;

  const makeDoctor = async (id: string) => {
    await prisma.doctor.create({ data: { id, clinicId: CLINIC, name: id } });
    return id;
  };

  const admit = async (doctorId: string) => {
    const mobile = `65${String(stamp).slice(-6)}${String(seq++).padStart(2, '0')}`;
    mobiles.push(mobile);
    const e = await enc.register({
      mobile,
      doctorId,
      serviceDate: '2026-07-28',
      source: RegistrationSource.APP,
      opCategoryId: NORMAL,
    });
    encounterIds.push(e.id);
    await checkin.checkIn(e.id, CheckInMethod.DESK, { issueToken: true });
    const r = await queue.enqueue(e.id);
    return { encounterId: e.id, sessionId: r.opSessionId };
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
      ],
    }).compile();
    await moduleRef.init();
    enc = moduleRef.get(EncounterService);
    checkin = moduleRef.get(CheckInService);
    queue = moduleRef.get(OpQueueService);
    engine = moduleRef.get(ConsultationEngineService);
    events = moduleRef.get(EventStoreService);
    prisma = moduleRef.get(PrismaService);
    redis = moduleRef.get(RedisService);

    await prisma.hospital.create({ data: { id: HOSPITAL, name: 'C Hosp' } });
    await prisma.clinic.create({
      data: { id: CLINIC, hospitalId: HOSPITAL, name: 'C Clinic' },
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
    const keys = await redis.redis.keys('pfos:q:*');
    if (keys.length) {
      // only delete keys for our sessions (clinic-scoped doctors)
      const docs = (await prisma.doctor.findMany({ where: { clinicId: CLINIC }, select: { id: true } })).map((d) => d.id);
      const mine = keys.filter((k) => docs.some((d) => k.includes(d)));
      if (mine.length) await redis.redis.del(...mine);
    }
    const allEnc = (await prisma.encounter.findMany({ where: { clinicId: CLINIC }, select: { id: true } })).map((e) => e.id);
    await prisma.domainEvent.deleteMany({ where: { streamId: { in: allEnc } } });
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

  it('call -> start -> complete drives the full happy path with events', async () => {
    const doc = await makeDoctor(`c-doc-happy-${stamp}`);
    const a = await admit(doc);
    const called = await engine.callNext(a.sessionId);
    expect(called?.encounter.status).toBe(EncounterStatus.CALLED);

    const consult = await engine.startConsultation(a.encounterId);
    expect(consult.state).toBe(ConsultationState.ACTIVE);
    const midEnc = await prisma.encounter.findUnique({ where: { id: a.encounterId } });
    expect(midEnc?.status).toBe(EncounterStatus.IN_CONSULTATION);

    const done = await engine.complete(a.encounterId);
    expect(done.state).toBe(ConsultationState.COMPLETED);
    const finalEnc = await prisma.encounter.findUnique({ where: { id: a.encounterId } });
    expect(finalEnc?.status).toBe(EncounterStatus.COMPLETED);

    const encStream = await events.loadStream('Encounter', a.encounterId);
    expect(encStream.map((s) => s.type)).toEqual([
      DomainEventType.EncounterCreated,
      DomainEventType.PatientCheckedIn,
      DomainEventType.TokenIssued,
      DomainEventType.QueueEntered,
      DomainEventType.PatientCalled,
    ]);
    const cStream = await events.loadStream('Consultation', consult.id);
    expect(cStream.map((s) => s.type)).toEqual([
      DomainEventType.ConsultationStarted,
      DomainEventType.ConsultationCompleted,
    ]);
  });

  it('enforces ONE active consultation per doctor', async () => {
    const doc = await makeDoctor(`c-doc-oneactive-${stamp}`);
    const a = await admit(doc);
    const b = await admit(doc);
    await engine.callNext(a.sessionId);
    await engine.startConsultation(a.encounterId);
    await engine.callNext(b.sessionId);
    await expect(engine.startConsultation(b.encounterId)).rejects.toBeInstanceOf(
      ConflictException,
    );
    // free the doctor
    await engine.complete(a.encounterId);
    const consult = await engine.startConsultation(b.encounterId);
    expect(consult.state).toBe(ConsultationState.ACTIVE);
  });

  it('skip removes from line; recall brings back; next call picks the other first', async () => {
    const doc = await makeDoctor(`c-doc-skip-${stamp}`);
    const a = await admit(doc);
    const b = await admit(doc);
    await engine.skip(a.encounterId); // a leaves the line
    const skipped = await prisma.encounter.findUnique({ where: { id: a.encounterId } });
    expect(skipped?.status).toBe(EncounterStatus.SKIPPED);
    // next call is b (a was skipped)
    const next1 = await engine.callNext(a.sessionId);
    expect(next1?.encounter.id).toBe(b.encounterId);
    // recall a -> back to waiting -> callable
    const recalled = await engine.recall(a.encounterId);
    expect(recalled.status).toBe(EncounterStatus.WAITING);
    const next2 = await engine.callNext(a.sessionId);
    expect(next2?.encounter.id).toBe(a.encounterId);
  });

  it('no-show removes a called patient from the line', async () => {
    const doc = await makeDoctor(`c-doc-noshow-${stamp}`);
    const a = await admit(doc);
    await engine.callNext(a.sessionId);
    const ns = await engine.noShow(a.encounterId);
    expect(ns.status).toBe(EncounterStatus.NO_SHOW);
    // queue empty now
    expect(await engine.callNext(a.sessionId)).toBeNull();
  });

  it('transfer moves the patient to another doctor with a reissued token', async () => {
    const from = await makeDoctor(`c-doc-from-${stamp}`);
    const to = await makeDoctor(`c-doc-to-${stamp}`);
    const a = await admit(from);
    const { old, newEncounterId } = await engine.transfer(a.encounterId, to);
    encounterIds.push(newEncounterId);
    expect(old.status).toBe(EncounterStatus.TRANSFERRED);
    const fresh = await prisma.encounter.findUnique({ where: { id: newEncounterId } });
    expect(fresh?.doctorId).toBe(to);
    expect(fresh?.status).toBe(EncounterStatus.WAITING); // checked-in, tokened, enqueued
    const newToken = await prisma.token.findUnique({ where: { encounterId: newEncounterId } });
    expect(newToken).not.toBeNull();
    const oldStream = await events.loadStream('Encounter', a.encounterId);
    expect(oldStream.map((s) => s.type)).toContain(DomainEventType.EncounterTransferred);
  });
});
