import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BookingSource, BookingStatus } from '@prisma/client';

// thresholds must be set BEFORE the app (ConfigModule) initialises
process.env.NOTIFY_APPROACHING_AHEAD = '4'; // fire when patientsAhead <= 4 (front 5)
process.env.NOTIFY_ARRIVAL_AHEAD = '0'; // fire when patientsAhead == 0 (front only)

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { SessionKey, TokenSource } from '../src/queue-engine/token.service';
import {
  NotificationsService,
  NotificationType,
} from '../src/notifications/notifications.service';
import { PUSH_SENDER, PushMessage, PushSender } from '../src/notifications/push.sender';

/** Records every push so the test can count by type. */
class FakePush implements PushSender {
  readonly sent: { deviceToken: string; message: PushMessage }[] = [];
  async send(deviceToken: string, message: PushMessage): Promise<void> {
    this.sent.push({ deviceToken, message });
  }
  countOf(type: NotificationType): number {
    return this.sent.filter((s) => s.message.data.type === type).length;
  }
  reset(): void {
    this.sent.length = 0;
  }
}

describe('NotificationsService — threshold-crossing, exactly-once (real Redis + Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let queue: QueueService;
  let notifications: NotificationsService;
  const push = new FakePush();

  const CLINIC_ID = 'notif-clinic';
  const DOCTOR_ID = 'notif-doctor';
  const session: SessionKey = {
    doctorId: DOCTOR_ID,
    sessionDate: '2026-06-19',
    sessionType: 'MORNING',
  };
  let seq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PUSH_SENDER)
      .useValue(push)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();

    prisma = app.get(PrismaService);
    queue = app.get(QueueService);
    notifications = app.get(NotificationsService);

    await prisma.clinic.upsert({
      where: { id: CLINIC_ID },
      create: { id: CLINIC_ID, name: 'Notif Clinic' },
      update: {},
    });
    await prisma.doctor.upsert({
      where: { id: DOCTOR_ID },
      create: { id: DOCTOR_ID, clinicId: CLINIC_ID, name: 'Dr Notif' },
      update: {},
    });
  });

  beforeEach(async () => {
    await clean();
    push.reset();
  });

  afterAll(async () => {
    await clean();
    await prisma.doctor.deleteMany({ where: { id: DOCTOR_ID } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC_ID } });
    await app.close();
  });

  async function clean(): Promise<void> {
    await queue.clearSession(session);
    await notifications.clearSessionFlags(session);
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR_ID } });
    await prisma.patient.deleteMany({ where: { id: { startsWith: 'notif-pt-' } } });
  }

  /**
   * Enqueue one BOOKED patient SILENTLY — straight onto the Redis queue with no
   * sessionChanged event — so building the queue does not itself fire any
   * notification. Returns the issued token.
   */
  async function silentEnqueue(): Promise<string> {
    const id = `notif-pt-${seq++}`;
    await prisma.patient.create({
      data: { id, name: id, mobile: `7${Date.now()}${seq}`, fcmToken: `fcm-${id}` },
    });
    const booking = await prisma.booking.create({
      data: {
        id: `notif-bk-${id}`,
        patientId: id,
        doctorId: DOCTOR_ID,
        source: BookingSource.APP,
        sessionDate: new Date(session.sessionDate),
        sessionType: 'MORNING',
        status: BookingStatus.BOOKED,
      },
    });
    const entry = await queue.enqueue(TokenSource.APP, session, booking.id);
    await prisma.booking.update({
      where: { id: booking.id },
      data: { tokenNumber: entry.tokenNumber },
    });
    return entry.tokenNumber;
  }

  it('a DONE that shifts five patients within threshold fires exactly five — and a later non-crossing mutation fires zero', async () => {
    // build 6 silently (no events, no notifications): A001..A006
    for (let i = 0; i < 6; i++) await silentEnqueue();
    expect(await queue.list(session)).toEqual(['A001', 'A002', 'A003', 'A004', 'A005', 'A006']);
    expect(push.sent.length).toBe(0);

    // DONE: pop the front (A001). Now A002..A006 — five within the approaching window.
    await queue.popFront(session);
    await notifications.onQueueEvent(session);

    // exactly five "approaching" notifications (A002..A006), none for the popped A001
    expect(push.countOf(NotificationType.QUEUE_APPROACHING)).toBe(5);
    // and the new front (A002) also gets the arrival reminder (own type, fires once)
    expect(push.countOf(NotificationType.ARRIVAL_REMINDER)).toBe(1);

    const afterFirst = push.sent.length;

    // a subsequent mutation that crosses nothing new: remove a back token (A006)
    await queue.removeToken('A006', session);
    await notifications.onQueueEvent(session);
    // re-scan of an unchanged head -> idempotent, zero new pushes
    expect(push.sent.length).toBe(afterFirst);

    // re-running the scan again with no change is also a no-op
    await notifications.onQueueEvent(session);
    expect(push.sent.length).toBe(afterFirst);
  });

  it('bookingConfirmed fires exactly once per booking', async () => {
    await silentEnqueue(); // A001, booking notif-bk-notif-pt-N
    const booking = await prisma.booking.findFirstOrThrow({ where: { doctorId: DOCTOR_ID } });

    await notifications.bookingConfirmed(booking.id);
    await notifications.bookingConfirmed(booking.id); // duplicate -> no-op

    expect(push.countOf(NotificationType.BOOKING_CONFIRMED)).toBe(1);
  });

  it('the event subscription drives notifications end-to-end (second consumer)', async () => {
    // build silently, then emit a real session-changed and let the subscription run
    for (let i = 0; i < 3; i++) await silentEnqueue();
    const events = app.get(
      // QueueEventsService is exported by QueueEngineModule
      (await import('../src/queue-engine/queue-events.service')).QueueEventsService,
    );
    events.sessionChanged(session);
    // subscription handler is fire-and-forget async -> let it settle
    await new Promise((r) => setTimeout(r, 50));

    // front 3 are all within the approaching window -> 3 fired via the subscription
    expect(push.countOf(NotificationType.QUEUE_APPROACHING)).toBe(3);
  });
});
