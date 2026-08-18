import { EncounterStatus } from '@prisma/client';
import { ReceptionQueueCompatService } from '../src/reception/reception-queue-compat.service';

/**
 * Read-cutover compat for the reception desk's live queue. Stubbed deps rather
 * than the full stack: the logic under test is the ordering + ETA arithmetic and
 * the session scoping, none of which needs a database.
 *
 * Context: a voice-agent booking is enqueued in the OP engine only, so the desk's
 * legacy ZSET snapshot omitted it — the phone-booked patient held a token nobody
 * at the desk could see in line.
 */
type Row = {
  tokenNumber: string | null;
  status: EncounterStatus;
  orderKey: number | null;
};

function make(opts: {
  rows: Row[];
  flag?: boolean;
  clinicId?: string | null;
  opSession?: { id: string } | null;
  avg?: number;
}) {
  const {
    rows,
    flag = true,
    clinicId = 'clinic-1',
    opSession = { id: 'op-session-1' },
    avg = 10,
  } = opts;

  const prisma = {
    doctor: {
      findUnique: jest.fn(async () => (clinicId ? { clinicId } : null)),
    },
    opSession: { findFirst: jest.fn(async () => opSession) },
    queueReadModel: {
      findFirst: jest.fn(async () =>
        rows.find((r) => r.status === EncounterStatus.IN_CONSULTATION) ?? null,
      ),
      findMany: jest.fn(async (_args: { where: Record<string, unknown> }) =>
        rows
          .filter((r) => r.status === EncounterStatus.WAITING)
          .sort((a, b) => (a.orderKey ?? 0) - (b.orderKey ?? 0)),
      ),
    },
  };
  const config = { get: jest.fn(async (_k: string, _s: unknown, fb: boolean) => flag ?? fb) };
  const eta = { avgConsultMinutes: jest.fn(async () => avg) };

  const svc = new ReceptionQueueCompatService(
    prisma as never,
    config as never,
    eta as never,
  );
  return { svc, prisma, config, eta };
}

const SESSION = {
  doctorId: 'doctor-1',
  sessionDate: '2026-08-18',
  sessionType: 'MORNING',
} as never;

describe('ReceptionQueueCompatService', () => {
  it('is disabled by default and enabled by the clinic flag', async () => {
    const off = make({ rows: [], flag: false });
    expect(await off.svc.enabled('doctor-1')).toBe(false);

    const on = make({ rows: [], flag: true });
    expect(await on.svc.enabled('doctor-1')).toBe(true);
  });

  it('is disabled for an unknown doctor without consulting config', async () => {
    const { svc, config } = make({ rows: [], clinicId: null });
    expect(await svc.enabled('ghost')).toBe(false);
    expect(config.get).not.toHaveBeenCalled();
  });

  it('returns the WAITING line ordered by orderKey, with legacy ETA arithmetic', async () => {
    const { svc } = make({
      rows: [
        { tokenNumber: 'N002', status: EncounterStatus.WAITING, orderKey: 2 },
        { tokenNumber: 'N001', status: EncounterStatus.WAITING, orderKey: 1 },
      ],
    });

    const queue = await svc.queue(SESSION);
    expect(queue.map((q) => q.tokenNumber)).toEqual(['N001', 'N002']);
    expect(queue[0]).toMatchObject({
      position: 1,
      patientsAhead: 0,
      total: 2,
      etaMinutes: 0,
      avgConsultMinutes: 10,
    });
    expect(queue[1]).toMatchObject({ position: 2, patientsAhead: 1, etaMinutes: 10 });
  });

  it('puts the IN_CONSULTATION patient at rank 0 ahead of the WAITING line', async () => {
    const { svc } = make({
      rows: [
        { tokenNumber: 'N005', status: EncounterStatus.WAITING, orderKey: 5 },
        { tokenNumber: 'N003', status: EncounterStatus.IN_CONSULTATION, orderKey: 3 },
      ],
    });

    const queue = await svc.queue(SESSION);
    expect(queue.map((q) => q.tokenNumber)).toEqual(['N003', 'N005']);
    expect(queue[0].patientsAhead).toBe(0);
  });

  it('drops pre-token encounters rather than emitting blank rows', async () => {
    const { svc } = make({
      rows: [
        { tokenNumber: null, status: EncounterStatus.WAITING, orderKey: 1 },
        { tokenNumber: '', status: EncounterStatus.WAITING, orderKey: 2 },
        { tokenNumber: 'N009', status: EncounterStatus.WAITING, orderKey: 3 },
      ],
    });

    const queue = await svc.queue(SESSION);
    expect(queue.map((q) => q.tokenNumber)).toEqual(['N009']);
    expect(queue[0].total).toBe(1);
  });

  it('returns an empty queue when the doctor has no session that day', async () => {
    const { svc, prisma } = make({
      rows: [{ tokenNumber: 'N001', status: EncounterStatus.WAITING, orderKey: 1 }],
      opSession: null,
    });

    expect(await svc.queue(SESSION)).toEqual([]);
    // no session -> never reads the queue projection at all
    expect(prisma.queueReadModel.findMany).not.toHaveBeenCalled();
  });

  it('scopes the projection read to the day\'s session, not the doctor', async () => {
    const { svc, prisma } = make({
      rows: [{ tokenNumber: 'N001', status: EncounterStatus.WAITING, orderKey: 1 }],
    });

    await svc.queue(SESSION);
    const where = prisma.queueReadModel.findMany.mock.calls[0]?.[0]?.where ?? {};
    expect(where.opSessionId).toBe('op-session-1');
    expect(where.doctorId).toBeUndefined();
  });
});
