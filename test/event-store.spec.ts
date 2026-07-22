import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { PrismaModule } from '../src/common/prisma/prisma.module';
import { EventStoreModule } from '../src/event-store/event-store.module';
import { EventStoreService } from '../src/event-store/event-store.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { DomainEventType } from '../src/event-store/domain-event.types';

/**
 * Event store (Phase 13): append-only, optimistic concurrency, replay order.
 * Runs against the real Postgres (DATABASE_URL). Each test uses a unique stream
 * id so it is isolated without truncating the shared table.
 */
describe('EventStoreService', () => {
  let store: EventStoreService;
  let prisma: PrismaService;
  const ids: string[] = [];

  const freshId = (p: string): string => {
    const id = `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    ids.push(id);
    return id;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, EventStoreModule],
    }).compile();
    await moduleRef.init();
    store = moduleRef.get(EventStoreService);
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    if (ids.length) {
      await prisma.domainEvent.deleteMany({
        where: { streamId: { in: ids } },
      });
    }
    await prisma.$disconnect();
  });

  it('appends events with contiguous, monotonic versions', async () => {
    const streamId = freshId('enc');
    const e1 = await store.append(
      {
        streamType: 'Encounter',
        streamId,
        type: DomainEventType.EncounterCreated,
        payload: { doctorId: 'd1' },
      },
      0,
    );
    expect(e1.version).toBe(1);
    const e2 = await store.append(
      {
        streamType: 'Encounter',
        streamId,
        type: DomainEventType.PatientCheckedIn,
        payload: {},
      },
      e1.version,
    );
    expect(e2.version).toBe(2);
    expect(await store.currentVersion('Encounter', streamId)).toBe(2);
  });

  it('rejects a stale expectedVersion with 409 (optimistic concurrency)', async () => {
    const streamId = freshId('enc');
    await store.append(
      {
        streamType: 'Encounter',
        streamId,
        type: DomainEventType.EncounterCreated,
        payload: {},
      },
      0,
    );
    // Second writer still thinks version is 0 -> collides on version 1.
    await expect(
      store.append(
        {
          streamType: 'Encounter',
          streamId,
          type: DomainEventType.TokenIssued,
          payload: {},
        },
        0,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('only ONE of N concurrent writers wins the same version slot', async () => {
    const streamId = freshId('enc');
    const attempts = Array.from({ length: 8 }, (_, i) =>
      store
        .append(
          {
            streamType: 'Encounter',
            streamId,
            type: DomainEventType.PatientCalled,
            payload: { i },
          },
          0,
        )
        .then(() => 'ok')
        .catch((e) =>
          e instanceof ConflictException ? 'conflict' : 'error',
        ),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'conflict')).toHaveLength(7);
    expect(results.filter((r) => r === 'error')).toHaveLength(0);
  });

  it('appendMany writes a batch atomically to one stream', async () => {
    const streamId = freshId('enc');
    const written = await store.appendMany(
      'Encounter',
      streamId,
      [
        { type: DomainEventType.EncounterCreated, payload: {} },
        { type: DomainEventType.PatientCheckedIn, payload: {} },
        { type: DomainEventType.TokenIssued, payload: { token: 'N001' } },
      ],
      0,
    );
    expect(written.map((e) => e.version)).toEqual([1, 2, 3]);
    const loaded = await store.loadStream('Encounter', streamId);
    expect(loaded).toHaveLength(3);
    expect(loaded[2].payload.token).toBe('N001');
  });

  it('loadStream returns events in version order', async () => {
    const streamId = freshId('enc');
    await store.appendMany(
      'Encounter',
      streamId,
      [
        { type: DomainEventType.EncounterCreated, payload: {} },
        { type: DomainEventType.PatientArrived, payload: {} },
      ],
      0,
    );
    const loaded = await store.loadStream('Encounter', streamId);
    expect(loaded.map((e) => e.version)).toEqual([1, 2]);
    expect(loaded[0].type).toBe(DomainEventType.EncounterCreated);
  });

  it('replay yields total order across streams and advances the cursor', async () => {
    const a = freshId('enc');
    const b = freshId('enc');
    const first = await store.append(
      {
        streamType: 'Encounter',
        streamId: a,
        type: DomainEventType.EncounterCreated,
        payload: {},
      },
      0,
    );
    await store.append(
      {
        streamType: 'Encounter',
        streamId: b,
        type: DomainEventType.EncounterCreated,
        payload: {},
      },
      0,
    );
    // Replay from just before our first event; both should appear, in globalSeq order.
    const { events, cursor } = await store.replay(first.globalSeq - 1n, 1000);
    const mine = events.filter((e) => e.streamId === a || e.streamId === b);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    // globalSeq strictly increasing
    for (let i = 1; i < events.length; i++) {
      expect(events[i].globalSeq > events[i - 1].globalSeq).toBe(true);
    }
    expect(cursor >= first.globalSeq).toBe(true);
  });
});
