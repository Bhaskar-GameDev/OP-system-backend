import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import {
  BookingSource,
  BookingStatus,
  PushPlatform,
  SessionType,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthTokenService } from '../src/auth/auth-token.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import {
  buildFcmMessage,
  DevicePlatform,
  PUSH_SENDER,
  PushMessage,
  PushSender,
} from '../src/notifications/push.sender';

/** Records the platform each push was sent with, not just the payload. */
class FakePush implements PushSender {
  readonly sent: {
    deviceToken: string;
    message: PushMessage;
    platform: DevicePlatform;
  }[] = [];

  async send(
    deviceToken: string,
    message: PushMessage,
    platform: DevicePlatform = null,
  ): Promise<void> {
    this.sent.push({ deviceToken, message, platform });
  }

  reset(): void {
    this.sent.length = 0;
  }
}

/**
 * Platform-aware push: registration, message construction, and the backward
 * compatibility rule that a null platform means Android.
 *
 * The message-shape tests are pure unit tests over buildFcmMessage — proving the
 * iOS branch needs no real device and no live FCM, which is the whole reason
 * that function is exported.
 */
describe('Push platform awareness', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let notifications: NotificationsService;
  const push = new FakePush();

  const CLINIC = 'pp-clinic';
  const DOCTOR = 'pp-doctor';
  const PT_IOS = 'pp-pt-ios';
  const PT_ANDROID = 'pp-pt-android';
  const PT_LEGACY = 'pp-pt-legacy';

  const DATE = '2026-06-21';
  let iosToken = '';
  let androidToken = '';
  let legacyToken = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PUSH_SENDER)
      .useValue(push)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    prisma = app.get(PrismaService);
    notifications = app.get(NotificationsService);
    const tokens = app.get(AuthTokenService);

    await cleanup();

    await prisma.clinic.create({ data: { id: CLINIC, name: 'Push Platform Clinic' } });
    await prisma.doctor.create({
      data: { id: DOCTOR, clinicId: CLINIC, name: 'Dr Push', avgConsultMinutes: 5 },
    });
    await prisma.patient.createMany({
      data: [
        { id: PT_IOS, name: 'iOS Patient', mobile: '9510000001' },
        { id: PT_ANDROID, name: 'Android Patient', mobile: '9510000002' },
        { id: PT_LEGACY, name: 'Legacy Patient', mobile: '9510000003' },
      ],
    });

    iosToken = tokens.sign({ sub: PT_IOS, role: 'PATIENT' });
    androidToken = tokens.sign({ sub: PT_ANDROID, role: 'PATIENT' });
    legacyToken = tokens.sign({ sub: PT_LEGACY, role: 'PATIENT' });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR } });
    await prisma.doctor.deleteMany({ where: { id: DOCTOR } });
    await prisma.patient.deleteMany({
      where: { id: { in: [PT_IOS, PT_ANDROID, PT_LEGACY] } },
    });
    await prisma.clinic.deleteMany({ where: { id: CLINIC } });
  }

  const register = (token: string, body: unknown) =>
    fetch(`${url}/notifications/device`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

  // ── registration ───────────────────────────────────────────
  describe('POST /notifications/device', () => {
    it('stores an iOS token with its platform', async () => {
      const res = await register(iosToken, {
        fcmToken: 'fcm-ios-token',
        platform: 'ios',
      });
      expect(res.status).toBe(201);

      const patient = await prisma.patient.findUnique({ where: { id: PT_IOS } });
      expect(patient?.fcmToken).toBe('fcm-ios-token');
      expect(patient?.pushPlatform).toBe(PushPlatform.IOS);
    });

    it('stores an Android token with its platform', async () => {
      const res = await register(androidToken, {
        fcmToken: 'fcm-android-token',
        platform: 'android',
      });
      expect(res.status).toBe(201);

      const patient = await prisma.patient.findUnique({ where: { id: PT_ANDROID } });
      expect(patient?.fcmToken).toBe('fcm-android-token');
      expect(patient?.pushPlatform).toBe(PushPlatform.ANDROID);
    });

    it('accepts a registration with no platform — an app build predating the field', async () => {
      const res = await register(legacyToken, { fcmToken: 'fcm-legacy-token' });
      expect(res.status).toBe(201);

      const patient = await prisma.patient.findUnique({ where: { id: PT_LEGACY } });
      expect(patient?.fcmToken).toBe('fcm-legacy-token');
      expect(patient?.pushPlatform).toBeNull();
    });

    it('rejects an unrecognised platform rather than storing it', async () => {
      const res = await register(iosToken, {
        fcmToken: 'fcm-ios-token',
        platform: 'windows',
      });
      expect(res.status).toBe(400);
    });

    it('rejects a missing or blank token', async () => {
      expect((await register(iosToken, {})).status).toBe(400);
      expect((await register(iosToken, { fcmToken: '   ' })).status).toBe(400);
      expect((await register(iosToken, { fcmToken: 42 })).status).toBe(400);
    });

    it('still requires authentication', async () => {
      const res = await fetch(`${url}/notifications/device`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fcmToken: 'x', platform: 'ios' }),
      });
      expect(res.status).toBe(401);
    });
  });

  // ── message construction ───────────────────────────────────
  describe('buildFcmMessage', () => {
    const message: PushMessage = {
      title: "You're almost up!",
      body: '1 patient ahead of you.',
      data: { type: 'ARRIVAL_REMINDER', token: 'A001' },
    };

    it('adds the apns block for an iOS target', () => {
      expect(buildFcmMessage('tok', message, 'IOS')).toEqual({
        token: 'tok',
        notification: { title: message.title, body: message.body },
        data: message.data,
        apns: { payload: { aps: { sound: 'default', badge: 1 } } },
      });
    });

    it('omits the apns block for Android', () => {
      const built = buildFcmMessage('tok', message, 'ANDROID');
      expect(built.apns).toBeUndefined();
      expect(built).toEqual({
        token: 'tok',
        notification: { title: message.title, body: message.body },
        data: message.data,
      });
    });

    it('treats a null platform as Android — the pre-column default', () => {
      expect(buildFcmMessage('tok', message, null)).toEqual(
        buildFcmMessage('tok', message, 'ANDROID'),
      );
    });

    it('carries the same notification and data on both platforms', () => {
      const ios = buildFcmMessage('tok', message, 'IOS');
      const android = buildFcmMessage('tok', message, 'ANDROID');
      expect(ios.notification).toEqual(android.notification);
      expect(ios.data).toEqual(android.data);
      expect(ios.token).toBe(android.token);
    });
  });

  // ── end-to-end propagation ─────────────────────────────────
  describe('platform reaches the sender', () => {
    /** A paid booking for `patientId`, ready for bookingConfirmed to fire on. */
    async function bookingFor(patientId: string, token: string): Promise<string> {
      const booking = await prisma.booking.create({
        data: {
          patientId,
          doctorId: DOCTOR,
          source: BookingSource.APP,
          tokenNumber: token,
          sessionDate: new Date(`${DATE}T00:00:00.000Z`),
          sessionType: SessionType.MORNING,
          status: BookingStatus.BOOKED,
        },
        select: { id: true },
      });
      return booking.id;
    }

    beforeEach(() => push.reset());

    it("sends an iOS patient's push with the IOS platform", async () => {
      const bookingId = await bookingFor(PT_IOS, 'A101');
      await notifications.bookingConfirmed(bookingId);

      expect(push.sent).toHaveLength(1);
      expect(push.sent[0].deviceToken).toBe('fcm-ios-token');
      expect(push.sent[0].platform).toBe(PushPlatform.IOS);
    });

    it("sends an Android patient's push with the ANDROID platform", async () => {
      const bookingId = await bookingFor(PT_ANDROID, 'A102');
      await notifications.bookingConfirmed(bookingId);

      expect(push.sent).toHaveLength(1);
      expect(push.sent[0].platform).toBe(PushPlatform.ANDROID);
    });

    it('sends a pre-column registration with a null platform, which builds an Android message', async () => {
      const bookingId = await bookingFor(PT_LEGACY, 'A103');
      await notifications.bookingConfirmed(bookingId);

      expect(push.sent).toHaveLength(1);
      expect(push.sent[0].platform).toBeNull();
      expect(
        buildFcmMessage('fcm-legacy-token', push.sent[0].message, push.sent[0].platform)
          .apns,
      ).toBeUndefined();
    });
  });
});
