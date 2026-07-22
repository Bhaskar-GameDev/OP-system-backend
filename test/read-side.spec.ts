import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
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
import { OpQueueModule } from '../src/queue/op-queue.module';
import { ConsultationModule } from '../src/consultation/consultation.module';
import { ReadSideModule } from '../src/read-side/read-side.module';
import { EncounterService } from '../src/encounters/encounter.service';
import { CheckInService } from '../src/check-in/checkin.service';
import { OpQueueService } from '../src/queue/op-queue.service';
import { ConsultationEngineService } from '../src/consultation/consultation-engine.service';
import { ProjectionRunner } from '../src/read-side/projection-runner.service';
import { QueueReadService } from '../src/read-side/queue-read.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RedisService } from '../src/common/redis/redis.service';
import {
  NOTIFICATION_PROVIDERS,
  NotificationChannel,
  NotificationProvider,
  OutboundNotification,
} from '../src/read-side/notification-provider';

class CapturingProvider implements NotificationProvider {
  readonly channels: NotificationChannel[] = ['PUSH', 'SMS', 'IN_APP'];
  sent: OutboundNotification[] = [];
  async send(n: OutboundNotification): Promise<void> {
    this.sent.push(n);
  }
}

describe('CQRS read models + notification pipeline (Phases 10+14)', () => {
  let enc: EncounterService;
  let checkin: CheckInService;
  let queue: OpQueueService;
  let engine: ConsultationEngineService;
  let runner: ProjectionRunner;
  let reads: QueueReadService;
  let prisma: PrismaService;
  let redis: RedisService;
  let moduleRef: TestingModule;
  const capturing = new CapturingProvider();

  const stamp = Date.now();
  const HOSPITAL = `r-hosp-${stamp}`;
  const CLINIC = `r-clinic-${stamp}`;
  const DOCTOR = `r-doc-${stamp}`;
  const NORMAL = `r-normal-${stamp}`;
  const encounterIds: string[] = [];
  const mobiles: string[] = [];
  let seq = 0;

  const admit = async () => {
    const mobile = `67${String(stamp).slice(-6)}${String(seq++).padStart(2, '0')}`;
    mobiles.push(mobile);
    const e = await enc.register({
      mobile,
      name: `Pt${seq}`,
      doctorId: DOCTOR,
      serviceDate: '2026-07-30',
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
        ReadSideModule,
      ],
    })
      .overrideProvider(NOTIFICATION_PROVIDERS)
      .useValue([capturing])
      .compile();
    await moduleRef.init();
    enc = moduleRef.get(EncounterService);
    checkin = moduleRef.get(CheckInService);
    queue = moduleRef.get(OpQueueService);
    engine = moduleRef.get(ConsultationEngineService);
    runner = moduleRef.get(ProjectionRunner);
    reads = moduleRef.get(QueueReadService);
    prisma = moduleRef.get(PrismaService);
    redis = moduleRef.get(RedisService);

    await prisma.hospital.create({ data: { id: HOSPITAL, name: 'R Hosp' } });
    await prisma.clinic.create({
      data: { id: CLINIC, hospitalId: HOSPITAL, name: 'R Clinic' },
    });
    await prisma.doctor.create({
      data: { id: DOCTOR, clinicId: CLINIC, name: 'R Dr' },
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
    const keys = await redis.redis.keys(`pfos:q:*${DOCTOR}*`);
    if (keys.length) await redis.redis.del(...keys);
    await prisma.queueReadModel.deleteMany({ where: { clinicId: CLINIC } });
    await prisma.domainEvent.deleteMany({ where: { streamId: { in: encounterIds } } });
    const cons = (await prisma.consultation.findMany({ where: { encounterId: { in: encounterIds } }, select: { id: true } })).map((c) => c.id);
    await prisma.domainEvent.deleteMany({ where: { streamId: { in: cons } } });
    await prisma.consultation.deleteMany({ where: { encounterId: { in: encounterIds } } });
    await prisma.queueEntry.deleteMany({ where: { encounterId: { in: encounterIds } } });
    await prisma.token.deleteMany({ where: { encounterId: { in: encounterIds } } });
    await prisma.checkIn.deleteMany({ where: { encounterId: { in: encounterIds } } });
    await prisma.registration.deleteMany({ where: { encounterId: { in: encounterIds } } });
    await prisma.encounter.deleteMany({ where: { id: { in: encounterIds } } });
    await prisma.opSession.deleteMany({ where: { clinicId: CLINIC } });
    await prisma.patient.deleteMany({ where: { mobile: { in: mobiles } } });
    await prisma.tokenSeries.deleteMany({ where: { clinicId: CLINIC } });
    await prisma.doctor.deleteMany({ where: { id: DOCTOR } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC } });
    await prisma.hospital.deleteMany({ where: { id: HOSPITAL } });
    await moduleRef.close();
  });

  it('projects the read models and views them per consumer', async () => {
    const a = await admit();
    const b = await admit();
    const c = await admit();
    // Serve A: call + start
    await engine.callNext(a.sessionId);
    await engine.startConsultation(a.encounterId);

    await runner.runOnce();

    // liveQueue: B and C waiting, in order
    const live = await reads.liveQueue(a.sessionId);
    const liveIds = live.map((r) => r.encounterId);
    expect(liveIds).toEqual([b.encounterId, c.encounterId]);

    // doctorDashboard: A active, B+C waiting
    const dash = await reads.doctorDashboard(DOCTOR);
    expect(dash.active?.encounterId).toBe(a.encounterId);
    expect(dash.waiting.map((r) => r.encounterId)).toEqual([b.encounterId, c.encounterId]);

    // displayBoard: now serving = A's token, next = B, C
    const board = await reads.displayBoard(a.sessionId);
    expect(board.nowServing?.patientName).toBeDefined();
    expect(board.next).toHaveLength(2);

    // patientTracking for C: 1 ahead (B), now serving A's token
    const track = await reads.patientTracking(c.encounterId);
    expect(track?.status).toBe(EncounterStatus.WAITING);
    expect(track?.ahead).toBe(1);
    expect(track?.nowServingToken).toBeTruthy();
  });

  it('dispatches the expected notifications along the lifecycle', async () => {
    const mine = capturing.sent.filter((n) =>
      encounterIds.includes(n.data?.encounterId as string),
    );
    const keys = new Set(mine.map((n) => n.templateKey));
    expect(keys).toContain('registration_successful');
    expect(keys).toContain('token_generated');
    expect(keys).toContain('queue_position');
    expect(keys).toContain('doctor_calling');
    // token_generated body carries the actual token number
    const tok = mine.find((n) => n.templateKey === 'token_generated');
    expect(tok?.body).toMatch(/Your token is N\d{3}\./);
  });

  it('rebuild() replays the whole stream to an identical read model (event replay)', async () => {
    const before = await prisma.queueReadModel.findMany({
      where: { clinicId: CLINIC },
      orderBy: { encounterId: 'asc' },
    });
    const applied = await runner.rebuild();
    expect(applied).toBeGreaterThan(0);
    const after = await prisma.queueReadModel.findMany({
      where: { clinicId: CLINIC },
      orderBy: { encounterId: 'asc' },
    });
    expect(after.map((r) => [r.encounterId, r.status, r.tokenNumber])).toEqual(
      before.map((r) => [r.encounterId, r.status, r.tokenNumber]),
    );
  });
});
