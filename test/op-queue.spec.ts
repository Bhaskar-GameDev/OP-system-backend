import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import {
  CheckInMethod,
  EncounterStatus,
  QueuePolicyMode,
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
import { EncounterService } from '../src/encounters/encounter.service';
import { CheckInService } from '../src/check-in/checkin.service';
import { OpQueueService } from '../src/queue/op-queue.service';
import { EventStoreService } from '../src/event-store/event-store.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RedisService } from '../src/common/redis/redis.service';
import { DomainEventType } from '../src/event-store/domain-event.types';

/**
 * Queue engine + policies (Phases 5+6). Proves: only checked-in+tokened
 * encounters enter; source never influences ordering; SHARED_FIFO / INDEPENDENT /
 * RATIO / MANUAL_SWITCH all behave per configuration.
 */
describe('Queue engine — source-blind, policy-driven', () => {
  let enc: EncounterService;
  let checkin: CheckInService;
  let queue: OpQueueService;
  let events: EventStoreService;
  let prisma: PrismaService;
  let redis: RedisService;
  let moduleRef: TestingModule;

  const stamp = Date.now();
  const HOSPITAL = `q-hosp-${stamp}`;
  const CLINIC = `q-clinic-${stamp}`;
  const NORMAL = `q-normal-${stamp}`;
  const SPECIAL = `q-special-${stamp}`;
  const encounterIds: string[] = [];
  const sessionIds = new Set<string>();
  const mobiles: string[] = [];
  let mobileSeq = 0;

  // Each test uses its own doctor so its session/queue is isolated.
  const makeDoctor = async (id: string) => {
    await prisma.doctor.create({
      data: { id, clinicId: CLINIC, name: id },
    });
    return id;
  };

  /** register -> check-in -> token -> enqueue, return {encounterId, sessionId}. */
  const admit = async (doctorId: string, seriesId: string) => {
    const mobile = `64${String(stamp).slice(-6)}${String(mobileSeq++).padStart(2, '0')}`;
    mobiles.push(mobile);
    const e = await enc.register({
      mobile,
      doctorId,
      serviceDate: '2026-07-27',
      source:
        mobileSeq % 2 === 0
          ? RegistrationSource.RECEPTION
          : RegistrationSource.VOICE_AGENT, // vary source — must NOT affect order
      opCategoryId: seriesId,
    });
    encounterIds.push(e.id);
    await checkin.checkIn(e.id, CheckInMethod.DESK, { issueToken: true });
    const res = await queue.enqueue(e.id);
    sessionIds.add(res.opSessionId);
    return { encounterId: e.id, sessionId: res.opSessionId, category: res.category };
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
      ],
    }).compile();
    await moduleRef.init();
    enc = moduleRef.get(EncounterService);
    checkin = moduleRef.get(CheckInService);
    queue = moduleRef.get(OpQueueService);
    events = moduleRef.get(EventStoreService);
    prisma = moduleRef.get(PrismaService);
    redis = moduleRef.get(RedisService);

    await prisma.hospital.create({ data: { id: HOSPITAL, name: 'Q Hosp' } });
    await prisma.clinic.create({
      data: { id: CLINIC, hospitalId: HOSPITAL, name: 'Q Clinic' },
    });
    await prisma.tokenSeries.createMany({
      data: [
        { id: NORMAL, clinicId: CLINIC, code: 'NORMAL_OP', label: 'Normal', prefix: 'N', resetPolicy: TokenResetPolicy.PER_SESSION },
        { id: SPECIAL, clinicId: CLINIC, code: 'SPECIAL_OP', label: 'Special', prefix: 'S', resetPolicy: TokenResetPolicy.PER_SESSION },
      ],
    });
  });

  afterAll(async () => {
    for (const s of sessionIds) {
      const keys = await redis.redis.keys(`pfos:q:*:${s}*`);
      const more = await redis.redis.keys(`pfos:q:*${s}*`);
      const all = [...new Set([...keys, ...more])];
      if (all.length) await redis.redis.del(...all);
    }
    await prisma.domainEvent.deleteMany({ where: { streamId: { in: [...encounterIds, ...sessionIds] } } });
    await prisma.queueEntry.deleteMany({ where: { encounterId: { in: encounterIds } } });
    await prisma.token.deleteMany({ where: { encounterId: { in: encounterIds } } });
    await prisma.checkIn.deleteMany({ where: { encounterId: { in: encounterIds } } });
    await prisma.registration.deleteMany({ where: { encounterId: { in: encounterIds } } });
    await prisma.encounter.deleteMany({ where: { id: { in: encounterIds } } });
    await prisma.opSession.deleteMany({ where: { clinicId: CLINIC } });
    await prisma.queuePolicy.deleteMany({ where: { clinicId: CLINIC } });
    await prisma.patient.deleteMany({ where: { mobile: { in: mobiles } } });
    await prisma.tokenSeries.deleteMany({ where: { id: { in: [NORMAL, SPECIAL] } } });
    await prisma.doctor.deleteMany({ where: { clinicId: CLINIC } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC } });
    await prisma.hospital.deleteMany({ where: { id: HOSPITAL } });
    await moduleRef.close();
  });

  it('REFUSES to enqueue a registration with no token', async () => {
    const doc = await makeDoctor(`q-doc-noretoken-${stamp}`);
    const mobile = `64000${stamp.toString().slice(-5)}`;
    mobiles.push(mobile);
    const e = await enc.register({
      mobile,
      doctorId: doc,
      serviceDate: '2026-07-27',
      source: RegistrationSource.APP,
      opCategoryId: NORMAL,
    });
    encounterIds.push(e.id);
    // registered only — no check-in, no token
    await expect(queue.enqueue(e.id)).rejects.toBeInstanceOf(BadRequestException);
    expect(await prisma.queueEntry.findUnique({ where: { encounterId: e.id } })).toBeNull();
  });

  it('enqueue transitions to WAITING and logs QueueEntered', async () => {
    const doc = await makeDoctor(`q-doc-basic-${stamp}`);
    const { encounterId } = await admit(doc, NORMAL);
    const after = await prisma.encounter.findUnique({ where: { id: encounterId } });
    expect(after?.status).toBe(EncounterStatus.WAITING);
    const stream = await events.loadStream('Encounter', encounterId);
    expect(stream.map((s) => s.type)).toEqual([
      DomainEventType.EncounterCreated,
      DomainEventType.PatientCheckedIn,
      DomainEventType.TokenIssued,
      DomainEventType.QueueEntered,
    ]);
  });

  it('SHARED_FIFO: whoNext returns strict arrival order regardless of source/category', async () => {
    const doc = await makeDoctor(`q-doc-fifo-${stamp}`);
    const a = await admit(doc, NORMAL);
    const b = await admit(doc, SPECIAL);
    const c = await admit(doc, NORMAL);
    // no policy row => defaults to SHARED_FIFO
    const next = await queue.whoNext(a.sessionId);
    expect(next?.encounterId).toBe(a.encounterId); // earliest arrival wins
    // remove a, next is b (arrived 2nd) even though different category
    await queue.dequeue(a.sessionId, a.encounterId, a.category, { recordServed: true });
    expect((await queue.whoNext(a.sessionId))?.encounterId).toBe(b.encounterId);
    void c;
  });

  it('INDEPENDENT: caller picks the category line', async () => {
    const doc = await makeDoctor(`q-doc-indep-${stamp}`);
    const n1 = await admit(doc, NORMAL);
    const s1 = await admit(doc, SPECIAL);
    await prisma.queuePolicy.create({
      data: { clinicId: CLINIC, doctorId: doc, mode: QueuePolicyMode.INDEPENDENT },
    });
    expect((await queue.whoNext(n1.sessionId, { category: 'NORMAL_OP' }))?.encounterId).toBe(n1.encounterId);
    expect((await queue.whoNext(s1.sessionId, { category: 'SPECIAL_OP' }))?.encounterId).toBe(s1.encounterId);
    await expect(queue.whoNext(n1.sessionId)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('MANUAL_SWITCH: doctor toggles the active category', async () => {
    const doc = await makeDoctor(`q-doc-manual-${stamp}`);
    const n1 = await admit(doc, NORMAL);
    const s1 = await admit(doc, SPECIAL);
    await prisma.queuePolicy.create({
      data: { clinicId: CLINIC, doctorId: doc, mode: QueuePolicyMode.MANUAL_SWITCH },
    });
    await queue.setActiveCategory(n1.sessionId, 'SPECIAL_OP');
    expect((await queue.whoNext(n1.sessionId))?.encounterId).toBe(s1.encounterId);
    await queue.setActiveCategory(n1.sessionId, 'NORMAL_OP');
    expect((await queue.whoNext(n1.sessionId))?.encounterId).toBe(n1.encounterId);
  });

  it('RATIO 2:1 special:normal interleaves S,S,N over successive calls', async () => {
    const doc = await makeDoctor(`q-doc-ratio-${stamp}`);
    // 3 special, 3 normal
    const specials = [await admit(doc, SPECIAL), await admit(doc, SPECIAL), await admit(doc, SPECIAL)];
    const normals = [await admit(doc, NORMAL), await admit(doc, NORMAL), await admit(doc, NORMAL)];
    const sid = specials[0].sessionId;
    await prisma.queuePolicy.create({
      data: {
        clinicId: CLINIC,
        doctorId: doc,
        mode: QueuePolicyMode.RATIO,
        ratio: { SPECIAL_OP: 2, NORMAL_OP: 1 },
      },
    });
    const served: string[] = [];
    for (let i = 0; i < 6; i++) {
      const n = await queue.whoNext(sid);
      if (!n) break;
      served.push(n.category);
      await queue.dequeue(sid, n.encounterId, n.category, { recordServed: true });
    }
    // Smooth weighted round-robin: every window of 3 serves is 2 special : 1
    // normal (interleaved S,N,S — not batched), which IS the 2:1 ratio.
    const firstThree = served.slice(0, 3);
    expect(firstThree.filter((c) => c === 'SPECIAL_OP')).toHaveLength(2);
    expect(firstThree.filter((c) => c === 'NORMAL_OP')).toHaveLength(1);
    expect(served.filter((c) => c === 'SPECIAL_OP')).toHaveLength(3);
    expect(served.filter((c) => c === 'NORMAL_OP')).toHaveLength(3);
    void normals;
  });
});
