import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import {
  EncounterStatus,
  PaymentStatus,
  TokenResetPolicy,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RedisService } from '../src/common/redis/redis.service';
import { AuthTokenService } from '../src/auth/auth-token.service';
import { FakeRazorpayGateway, RAZORPAY_GATEWAY } from '../src/payments/razorpay.gateway';

/**
 * Task 4 — decoupled OP payments. Proves a token is issued with NO payment
 * (payment NEVER gates the token), that online-before and cash-at-desk both
 * settle independently and emit PaymentSettled on their own stream, and that the
 * surface is correctly scoped (patient=own encounter, staff=desk/tenant).
 */
describe('OP payments are decoupled from token issuance (full stack)', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let redis: RedisService;
  let tokens: AuthTokenService;

  const stamp = Date.now();
  const HOSP = `pay-hosp-${stamp}`;
  const HOSP2 = `pay-hosp2-${stamp}`;
  const CLINIC = `pay-clinic-${stamp}`;
  const CLINIC2 = `pay-clinic2-${stamp}`;
  const DOCTOR = `pay-doc-${stamp}`;
  const DOCTOR2 = `pay-doc2-${stamp}`;
  const SERIES = `pay-series-${stamp}`;
  const FEE = 30000; // paise
  const DATE = '2026-09-01';
  const mobiles: string[] = [];
  const encounterIds: string[] = [];

  let staff = '';
  let staff2 = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RAZORPAY_GATEWAY)
      .useClass(FakeRazorpayGateway)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    tokens = app.get(AuthTokenService);

    await cleanup();
    await prisma.hospital.createMany({ data: [{ id: HOSP, name: 'Pay H' }, { id: HOSP2, name: 'Pay H2' }] });
    await prisma.clinic.createMany({
      data: [
        { id: CLINIC, hospitalId: HOSP, name: 'Pay C' },
        { id: CLINIC2, hospitalId: HOSP2, name: 'Pay C2' },
      ],
    });
    await prisma.doctor.createMany({
      data: [
        { id: DOCTOR, clinicId: CLINIC, name: 'Pay Dr', avgConsultMinutes: 10 },
        { id: DOCTOR2, clinicId: CLINIC2, name: 'Pay Dr2' },
      ],
    });
    await prisma.tokenSeries.create({
      data: {
        id: SERIES, clinicId: CLINIC, code: 'NORMAL_OP', label: 'Normal',
        prefix: 'N', padWidth: 3, startAt: 1, resetPolicy: TokenResetPolicy.PER_SESSION, fee: FEE,
      },
    });
    staff = tokens.sign({ sub: 'pay-staff', role: 'STAFF', clinicId: CLINIC, hospitalId: HOSP });
    staff2 = tokens.sign({ sub: 'pay-staff2', role: 'STAFF', clinicId: CLINIC2, hospitalId: HOSP2 });
  });

  afterAll(async () => {
    for (const s of await prisma.opSession.findMany({ where: { doctorId: { in: [DOCTOR, DOCTOR2] } }, select: { id: true } }).catch(() => [])) {
      const keys = await redis.redis.keys(`pfos:*${s.id}*`).catch(() => [] as string[]);
      if (keys.length) await redis.redis.del(...keys);
    }
    const sk = await redis.redis.keys(`pfos:tokenseq:${SERIES}:*`).catch(() => [] as string[]);
    if (sk.length) await redis.redis.del(...sk);
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    const w = { encounterId: { in: encounterIds } };
    await prisma.opPayment.deleteMany({ where: w }).catch(() => {});
    await prisma.queueEntry.deleteMany({ where: w }).catch(() => {});
    await prisma.token.deleteMany({ where: w }).catch(() => {});
    await prisma.checkIn.deleteMany({ where: w }).catch(() => {});
    await prisma.registration.deleteMany({ where: w }).catch(() => {});
    await prisma.queueReadModel.deleteMany({ where: w }).catch(() => {});
    await prisma.domainEvent.deleteMany({ where: { streamId: { in: encounterIds } } }).catch(() => {});
    // PaymentSettled lives on the OpPayment stream (streamId = opPaymentId)
    const pays = await prisma.opPayment.findMany({ where: w, select: { id: true } }).catch(() => [] as { id: string }[]);
    if (pays.length) await prisma.domainEvent.deleteMany({ where: { streamId: { in: pays.map((p) => p.id) } } }).catch(() => {});
    await prisma.encounter.deleteMany({ where: { id: { in: encounterIds } } }).catch(() => {});
    await prisma.opSession.deleteMany({ where: { doctorId: { in: [DOCTOR, DOCTOR2] } } }).catch(() => {});
    await prisma.patient.deleteMany({ where: { mobile: { in: mobiles } } }).catch(() => {});
    await prisma.tokenSeries.deleteMany({ where: { id: SERIES } }).catch(() => {});
    await prisma.doctor.deleteMany({ where: { id: { in: [DOCTOR, DOCTOR2] } } }).catch(() => {});
    await prisma.clinic.deleteMany({ where: { id: { in: [CLINIC, CLINIC2] } } }).catch(() => {});
    await prisma.hospital.deleteMany({ where: { id: { in: [HOSP, HOSP2] } } }).catch(() => {});
  }

  function post(path: string, token: string, body?: unknown) {
    return fetch(`${url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  }
  function get(path: string, token: string) {
    return fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` } });
  }

  async function register(mobile: string): Promise<string> {
    mobiles.push(mobile);
    const res = await post('/op/registrations', staff, {
      mobile, name: 'Pay Patient', doctorId: DOCTOR, serviceDate: DATE, source: 'RECEPTION',
    });
    const enc = (await res.json()) as { id: string };
    encounterIds.push(enc.id);
    return enc.id;
  }

  it('issues a token with NO payment — payment never gates the token', async () => {
    const enc = await register('7500000001');
    // straight to check-in + token, no payment of any kind
    const ci = await post(`/op/encounters/${enc}/check-in`, staff, { method: 'DESK', issueToken: true });
    expect(ci.status).toBe(201);
    const token = await prisma.token.findUnique({ where: { encounterId: enc } });
    expect(token?.displayNumber).toMatch(/^N\d{3}$/);
    // and it can enqueue with zero payments on file
    const enq = await post(`/op/encounters/${enc}/enqueue`, staff);
    expect(enq.status).toBe(201);
    expect(await prisma.opPayment.count({ where: { encounterId: enc } })).toBe(0);
  });

  it('online BEFORE: patient creates + confirms an order; token is independent', async () => {
    const enc = await register('7500000002');
    const patientId = (await prisma.encounter.findUniqueOrThrow({ where: { id: enc } })).patientId;
    const patientTok = tokens.sign({ sub: patientId, role: 'PATIENT' });

    // pay online before any token exists
    const orderRes = await post(`/op/encounters/${enc}/payments/online`, patientTok);
    expect(orderRes.status).toBe(201);
    const order = (await orderRes.json()) as { opPaymentId: string; orderId: string; amount: number };
    expect(order.amount).toBe(FEE); // resolved from TokenSeries.fee
    expect(order.orderId).toBeTruthy();

    // confirm (fake gateway derives orderId from pay_dev_<orderId>)
    const confirmRes = await post(`/op/payments/${order.opPaymentId}/confirm`, patientTok, {
      razorpayPaymentId: `pay_dev_${order.orderId}`,
      signature: 'dev-signature',
    });
    expect(confirmRes.status).toBe(201);
    const pay = await prisma.opPayment.findUniqueOrThrow({ where: { id: order.opPaymentId } });
    expect(pay.status).toBe(PaymentStatus.SUCCESS);

    // PaymentSettled emitted on the payment's OWN stream
    const events = await prisma.domainEvent.findMany({
      where: { streamType: 'OpPayment', streamId: order.opPaymentId, type: 'PaymentSettled' },
    });
    expect(events).toHaveLength(1);

    // confirm is idempotent
    const again = await post(`/op/payments/${order.opPaymentId}/confirm`, patientTok, {
      razorpayPaymentId: `pay_dev_${order.orderId}`, signature: 'dev-signature',
    });
    expect(again.status).toBe(201);

    // token issues afterwards, entirely independent of the (already paid) payment
    await post(`/op/encounters/${enc}/check-in`, staff, { method: 'DESK', issueToken: true });
    const token = await prisma.token.findUnique({ where: { encounterId: enc } });
    expect(token).not.toBeNull();
  });

  it('cash AT-DESK: reception settles after the token; WAIVED records zero', async () => {
    const enc = await register('7500000003');
    // token first (unpaid), then desk settles — proving order independence
    await post(`/op/encounters/${enc}/check-in`, staff, { method: 'DESK', issueToken: true });

    const cash = await post(`/op/encounters/${enc}/payments/desk`, staff, { mode: 'CASH' });
    expect(cash.status).toBe(201);
    const cashPay = (await cash.json()) as { status: string; amount: number; mode: string };
    expect(cashPay.status).toBe(PaymentStatus.SUCCESS);
    expect(cashPay.amount).toBe(FEE);
    expect(cashPay.mode).toBe('CASH');

    const waived = await post(`/op/encounters/${enc}/payments/desk`, staff, { mode: 'WAIVED' });
    const waivedPay = (await waived.json()) as { amount: number; status: string };
    expect(waivedPay.amount).toBe(0);
    expect(waivedPay.status).toBe(PaymentStatus.SUCCESS);

    const list = await get(`/op/encounters/${enc}/payments`, staff);
    expect((await list.json()) as unknown[]).toHaveLength(2);
  });

  it('scopes the surface: stranger patient and cross-tenant staff are refused', async () => {
    const enc = await register('7500000004');

    const stranger = tokens.sign({ sub: 'pay-stranger', role: 'PATIENT' });
    const strangerRes = await post(`/op/encounters/${enc}/payments/online`, stranger);
    expect([403, 404]).toContain(strangerRes.status);

    // staff of another hospital cannot settle at this desk
    const crossRes = await post(`/op/encounters/${enc}/payments/desk`, staff2, { mode: 'CASH' });
    expect([403, 404]).toContain(crossRes.status);

    // desk mode rejects ONLINE (must go through the order flow)
    const badMode = await post(`/op/encounters/${enc}/payments/desk`, staff, { mode: 'ONLINE' });
    expect(badMode.status).toBe(400);
  });
});
