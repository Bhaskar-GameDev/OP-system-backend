import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { OpPaymentMode, PaymentStatus, TokenResetPolicy } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthTokenService } from '../src/auth/auth-token.service';
import { OpConfigService } from '../src/config-engine/op-config.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { SessionKey } from '../src/queue-engine/token.service';

/**
 * Desk money, end to end. Two things are being proven here:
 *
 *  1. A WALK-IN owes money like any other patient. It used to be registered with
 *     no Payment row at all, so cash taken at the counter existed nowhere in the
 *     system and the roster offered no way to record it.
 *  2. A collection says HOW (cash / UPI / corporate / waiver), HOW MUCH (the
 *     amount actually taken, not the fee assumed), and WHO took it — one button
 *     that only flipped a boolean could not distinguish a waiver from cash, nor
 *     name the person who collected.
 */
describe('Reception desk payment collection (full stack)', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let tokens: AuthTokenService;
  let queue: QueueService;
  let config: OpConfigService;

  const CLINIC = 'dp-clinic';
  const DOCTOR = 'dp-doc';
  const STAFF = 'dp-staff-1';
  const SERIES = 'dp-series';
  const FEE_RUPEES = 350;
  const FEE_PAISE = FEE_RUPEES * 100;
  const MOBILES = [
    '7200000001',
    '7200000002',
    '7200000003',
    '7200000004',
    '7200000005',
    '7200000006',
  ];
  const session: SessionKey = {
    doctorId: DOCTOR,
    sessionDate: '2026-06-23',
    sessionType: 'MORNING',
  };

  let staffToken = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    tokens = app.get(AuthTokenService);
    queue = app.get(QueueService);
    config = app.get(OpConfigService);

    await cleanup();
    await prisma.clinic.create({ data: { id: CLINIC, name: 'DP Clinic' } });
    await prisma.doctor.create({
      data: {
        id: DOCTOR,
        clinicId: CLINIC,
        name: 'DP Dr',
        consultationFee: FEE_RUPEES,
        avgConsultMinutes: 10,
      },
    });
    // A token series makes the OP mirror actually run for this clinic — without
    // one it skips (best effort) and no encounter exists to flip the roster to.
    // fee stays 0 on purpose: the desk amount must come from the doctor's fee.
    await prisma.tokenSeries.create({
      data: {
        id: SERIES,
        clinicId: CLINIC,
        code: 'NORMAL_OP',
        label: 'Normal',
        prefix: 'N',
        padWidth: 3,
        startAt: 1,
        resetPolicy: TokenResetPolicy.PER_SESSION,
      },
    });
    staffToken = tokens.sign({ sub: STAFF, role: 'STAFF', clinicId: CLINIC });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await queue.clearSession(session);
    const bookings = await prisma.booking.findMany({
      where: { doctorId: DOCTOR },
      select: { id: true },
    });
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR } });
    await prisma.payment.deleteMany({
      where: { bookingId: { in: bookings.map((b) => b.id) } },
    });
    const encounters = await prisma.encounter.findMany({
      where: { doctorId: DOCTOR },
      select: { id: true },
    });
    const encIds = encounters.map((e) => e.id);
    if (encIds.length > 0) {
      await prisma.opPayment.deleteMany({ where: { encounterId: { in: encIds } } });
      await prisma.token.deleteMany({ where: { encounterId: { in: encIds } } });
      await prisma.checkIn.deleteMany({ where: { encounterId: { in: encIds } } });
      await prisma.registration.deleteMany({ where: { encounterId: { in: encIds } } });
      await prisma.encounter.deleteMany({ where: { id: { in: encIds } } });
    }
    for (const sess of await prisma.opSession
      .findMany({ where: { doctorId: DOCTOR }, select: { id: true } })
      .catch(() => [])) {
      await prisma.queueEntry.deleteMany({ where: { opSessionId: sess.id } }).catch(() => {});
    }
    await prisma.opSession.deleteMany({ where: { doctorId: DOCTOR } }).catch(() => {});
    await prisma.tokenSeries.deleteMany({ where: { clinicId: CLINIC } });
    await prisma.patient.deleteMany({ where: { mobile: { in: MOBILES } } });
    await prisma.doctor.deleteMany({ where: { id: DOCTOR } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC } });
  }

  interface WalkInView {
    bookingId: string;
    tokenNumber: string;
  }
  interface RosterRow {
    bookingId: string;
    source: string;
    payAtDesk: boolean;
    paid: boolean;
    amountDuePaise: number;
    paidMode: string | null;
  }
  interface CollectView {
    bookingId: string;
    paid: boolean;
    amountPaise: number;
    mode: string;
  }

  async function walkin(mobile: string, name: string): Promise<WalkInView> {
    const res = await fetch(`${url}/reception/walkins`, {
      method: 'POST',
      headers: { authorization: `Bearer ${staffToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mobile, name, ...session }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as WalkInView;
  }

  function collect(bookingId: string, body?: Record<string, unknown>) {
    return fetch(`${url}/reception/bookings/${bookingId}/collect-payment`, {
      method: 'POST',
      headers: { authorization: `Bearer ${staffToken}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function roster(): Promise<RosterRow[]> {
    const q = new URLSearchParams({
      doctorId: DOCTOR,
      sessionDate: session.sessionDate,
      sessionType: session.sessionType,
    });
    const res = await fetch(`${url}/reception/bookings?${q.toString()}`, {
      headers: { authorization: `Bearer ${staffToken}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as RosterRow[];
  }

  async function rowFor(bookingId: string): Promise<RosterRow> {
    const row = (await roster()).find((r) => r.bookingId === bookingId);
    if (!row) throw new Error(`no roster row for ${bookingId}`);
    return row;
  }

  /**
   * The mirrored encounter for a legacy booking. A desk-created one carries the
   * id on the encounter; a mirrored one carries it in Registration.channelMeta —
   * the walk-in path uses the latter.
   */
  async function encounterIdFor(bookingId: string): Promise<string | null> {
    const direct = await prisma.encounter.findFirst({
      where: { legacyBookingId: bookingId },
      select: { id: true },
    });
    if (direct) return direct.id;
    const reg = await prisma.registration.findFirst({
      where: { channelMeta: { path: ['legacyBookingId'], equals: bookingId } },
      select: { encounterId: true },
    });
    return reg?.encounterId ?? null;
  }

  it('a walk-in owes the fee at the desk — unpaid Payment, roster shows the amount due', async () => {
    const w = await walkin(MOBILES[0], 'Due Patient');

    const booking = await prisma.booking.findUniqueOrThrow({
      where: { id: w.bookingId },
      select: { payAtDesk: true, payment: { select: { status: true, amount: true } } },
    });
    expect(booking.payAtDesk).toBe(true);
    expect(booking.payment?.status).toBe(PaymentStatus.CREATED);
    expect(booking.payment?.amount).toBe(FEE_PAISE);

    const row = await rowFor(w.bookingId);
    expect(row.source).toBe('WALK_IN');
    expect(row.payAtDesk).toBe(true);
    expect(row.paid).toBe(false);
    expect(row.amountDuePaise).toBe(FEE_PAISE);
    expect(row.paidMode).toBeNull();
  });

  it('collecting records the mode, the amount actually taken, and the staff who took it', async () => {
    const w = await walkin(MOBILES[1], 'Upi Patient');
    const PART = 30000; // ₹300 — a concession off the ₹350 fee

    const res = await collect(w.bookingId, { mode: 'UPI_DESK', amountPaise: PART });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CollectView;
    expect(body.paid).toBe(true);
    expect(body.mode).toBe('UPI_DESK');
    expect(body.amountPaise).toBe(PART);

    // legacy Payment settled at the amount actually taken (revenue is not the fee)
    const pay = await prisma.payment.findFirstOrThrow({ where: { bookingId: w.bookingId } });
    expect(pay.status).toBe(PaymentStatus.SUCCESS);
    expect(pay.amount).toBe(PART);

    // the mode and the collector live on the row itself — no encounter needed
    expect(pay.deskMode).toBe(OpPaymentMode.UPI_DESK);
    expect(pay.collectedById).toBe(STAFF);
    expect(pay.collectedAt).not.toBeNull();

    // when the visit was mirrored to the new engine, the decoupled OpPayment and
    // its PaymentSettled event carry the same facts
    const encId = await encounterIdFor(w.bookingId);
    if (encId) {
      const opPay = await prisma.opPayment.findFirstOrThrow({
        where: { encounterId: encId, status: PaymentStatus.SUCCESS },
      });
      expect(opPay.mode).toBe(OpPaymentMode.UPI_DESK);
      expect(opPay.amount).toBe(PART);
      const event = await prisma.domainEvent.findFirstOrThrow({
        where: { streamType: 'OpPayment', streamId: opPay.id, type: 'PaymentSettled' },
      });
      expect((event.metadata as { actorId?: string }).actorId).toBe(STAFF);
    }

    // roster now reads back paid, with how
    const row = await rowFor(w.bookingId);
    expect(row.paid).toBe(true);
    expect(row.paidMode).toBe('UPI_DESK');
    expect(row.amountDuePaise).toBe(PART);
  });

  it('a waiver settles zero, whatever amount is sent', async () => {
    const w = await walkin(MOBILES[2], 'Waived Patient');

    const body = (await (
      await collect(w.bookingId, { mode: 'WAIVED', amountPaise: FEE_PAISE })
    ).json()) as CollectView;
    expect(body.mode).toBe('WAIVED');
    expect(body.amountPaise).toBe(0);

    const pay = await prisma.payment.findFirstOrThrow({ where: { bookingId: w.bookingId } });
    expect(pay.status).toBe(PaymentStatus.SUCCESS);
    expect(pay.amount).toBe(0); // a waiver must never show up as revenue

    const row = await rowFor(w.bookingId);
    expect(row.paidMode).toBe('WAIVED');
  });

  it('an empty body still settles CASH at the full amount (older reception builds)', async () => {
    const w = await walkin(MOBILES[3], 'Legacy Client');

    const body = (await (await collect(w.bookingId)).json()) as CollectView;
    expect(body.mode).toBe('CASH');
    expect(body.amountPaise).toBe(FEE_PAISE);

    // idempotent: a second collect reports the first settlement, never charges twice
    const again = (await (
      await collect(w.bookingId, { mode: 'WAIVED' })
    ).json()) as CollectView;
    expect(again.amountPaise).toBe(FEE_PAISE); // NOT re-settled as a waiver
    expect(again.mode).toBe('CASH');
    const encId = await encounterIdFor(w.bookingId);
    if (encId) {
      expect(
        await prisma.opPayment.count({
          where: { encounterId: encId, status: PaymentStatus.SUCCESS },
        }),
      ).toBe(1);
    }
  });

  /**
   * What the reception app actually hits on a read-flipped clinic: the roster row
   * carries an encounterId, so the collection settles the decoupled OpPayment.
   * The legacy Payment behind the same visit must not be left sitting at CREATED —
   * every un-flipped surface, the revenue report included, still reads that row.
   */
  it('settling against an encounterId also clears the legacy payment behind it', async () => {
    const w = await walkin(MOBILES[4], 'Flipped Desk');
    const encId = await encounterIdFor(w.bookingId);
    expect(encId).not.toBeNull();

    await config.set('CLINIC', CLINIC, 'reads.cutover.roster', true);
    try {
      // the flipped roster addresses the row by encounterId
      const res = await collect(encId as string, { mode: 'CASH', amountPaise: 20000 });
      expect(res.status).toBe(201);
      const body = (await res.json()) as CollectView;
      expect(body.amountPaise).toBe(20000);

      const opPay = await prisma.opPayment.findFirstOrThrow({
        where: { encounterId: encId as string, status: PaymentStatus.SUCCESS },
      });
      expect(opPay.mode).toBe(OpPaymentMode.CASH);

      // …and the legacy twin is settled to match, with the same audit stamps
      const pay = await prisma.payment.findFirstOrThrow({
        where: { bookingId: w.bookingId },
      });
      expect(pay.status).toBe(PaymentStatus.SUCCESS);
      expect(pay.amount).toBe(20000);
      expect(pay.deskMode).toBe(OpPaymentMode.CASH);
      expect(pay.collectedById).toBe(STAFF);
    } finally {
      await config.set('CLINIC', CLINIC, 'reads.cutover.roster', false);
    }
  });

  it('rejects a mode the desk cannot take, and a negative amount', async () => {
    const w = await walkin(MOBILES[5], 'Bad Input');
    expect((await collect(w.bookingId, { mode: 'ONLINE' })).status).toBe(400);
    expect((await collect(w.bookingId, { mode: 'CASH', amountPaise: -1 })).status).toBe(400);
  });
});
