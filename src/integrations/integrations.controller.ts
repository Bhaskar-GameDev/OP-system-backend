import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { SMS_SENDER, SmsSender } from '../auth/sms.sender';
import { PUSH_SENDER, PushSender } from '../notifications/push.sender';

/** Result shape for a connectivity test — never throws to the client. */
interface TestResult {
  ok: boolean;
  mode: 'live' | 'dev-fallback';
  detail: string;
}

/**
 * Admin-only operational endpoints to validate the three external integrations
 * against real credentials. Read-only health report + explicit test sends. When
 * credentials are absent these exercise the SAME dev-fallback path as production
 * code (log instead of call out), so they are safe to hit locally.
 */
@Controller('integrations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class IntegrationsController {
  constructor(
    private readonly config: ConfigService,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    @Inject(PUSH_SENDER) private readonly push: PushSender,
  ) {}

  private has(key: string): boolean {
    const v = this.config.get<string>(key);
    return !!v && v.trim().length > 0;
  }

  /**
   * GET /integrations/health — which integrations are configured for live use.
   *
   * Default is a fast, side-effect-free config-presence report. Pass `?probe=true`
   * for a DEEP check that actually reaches the providers to prove the credentials
   * work (not merely that the env var is set):
   *   - Razorpay: an authenticated `GET /v1/payments?count=1` — a 200 proves the
   *     key id/secret pair is valid and the API is reachable.
   *   - FCM: validates the service-account JSON parses + carries a project_id
   *     (true send reachability is proven by POST /integrations/test-push, which
   *     would otherwise consume a real push).
   *   - MSG91: has no free reachability endpoint; a real send (test-sms) is the
   *     probe, so this stays config-presence only and says so.
   * Probes never throw — each reports `{ reachable, detail }`.
   */
  @Get('health')
  async health(@Query('probe') probe?: string) {
    const fcmConfigured = this.has('FCM_SERVICE_ACCOUNT_JSON') || this.has('FCM_SERVICE_ACCOUNT_PATH');
    const deep = probe === 'true' || probe === '1';

    const base = {
      msg91: {
        configured: this.has('MSG91_AUTH_KEY'),
        templateId: this.has('MSG91_OTP_TEMPLATE_ID'),
        senderId: this.has('MSG91_SENDER_ID'),
      },
      razorpay: {
        configured: this.has('RAZORPAY_KEY_ID') && this.has('RAZORPAY_KEY_SECRET'),
        webhookSecret: this.has('RAZORPAY_WEBHOOK_SECRET'),
      },
      fcm: { configured: fcmConfigured },
      testMobileConfigured: this.has('INTEGRATIONS_TEST_MOBILE'),
    };
    if (!deep) return base;

    const [razorpay, fcm, msg91] = await Promise.all([
      this.probeRazorpay(),
      this.probeFcm(),
      Promise.resolve(this.probeMsg91()),
    ]);
    return {
      ...base,
      probe: { msg91, razorpay, fcm },
    };
  }

  /** Live Razorpay reachability: an authed list call. 200 -> key pair valid. */
  private async probeRazorpay(): Promise<TestResult> {
    const id = this.config.get<string>('RAZORPAY_KEY_ID');
    const secret = this.config.get<string>('RAZORPAY_KEY_SECRET');
    if (!id || !secret) {
      return { ok: false, mode: 'dev-fallback', detail: 'Razorpay not configured — mock gateway in use.' };
    }
    try {
      const auth = Buffer.from(`${id}:${secret}`).toString('base64');
      const res = await fetch('https://api.razorpay.com/v1/payments?count=1', {
        headers: { authorization: `Basic ${auth}` },
      });
      if (res.ok) {
        return { ok: true, mode: 'live', detail: `Razorpay reachable; key ${id} authenticated.` };
      }
      const text = await res.text();
      return { ok: false, mode: 'live', detail: `Razorpay rejected the key: ${res.status} ${text.slice(0, 200)}` };
    } catch (err) {
      return { ok: false, mode: 'live', detail: `Razorpay unreachable: ${(err as Error).message}` };
    }
  }

  /** FCM credential validity: service account parses + has a project_id. */
  private probeFcm(): TestResult {
    const inline = this.config.get<string>('FCM_SERVICE_ACCOUNT_JSON');
    const path = this.config.get<string>('FCM_SERVICE_ACCOUNT_PATH');
    if (!inline && !path) {
      return { ok: false, mode: 'dev-fallback', detail: 'FCM not configured — push logged to console.' };
    }
    if (inline) {
      try {
        const sa = JSON.parse(inline) as { project_id?: string };
        return sa.project_id
          ? { ok: true, mode: 'live', detail: `FCM service account valid (project ${sa.project_id}). Confirm delivery with test-push.` }
          : { ok: false, mode: 'live', detail: 'FCM_SERVICE_ACCOUNT_JSON parsed but has no project_id.' };
      } catch {
        return { ok: false, mode: 'live', detail: 'FCM_SERVICE_ACCOUNT_JSON is not valid JSON.' };
      }
    }
    return { ok: true, mode: 'live', detail: `FCM service account file configured (${path}). Confirm delivery with test-push.` };
  }

  /** MSG91 has no free reachability endpoint — direct ops to the real send. */
  private probeMsg91(): TestResult {
    const live = this.has('MSG91_AUTH_KEY');
    return live
      ? { ok: true, mode: 'live', detail: 'MSG91 auth key set. Reachability is proven by POST /integrations/test-sms (sends a real SMS).' }
      : { ok: false, mode: 'dev-fallback', detail: 'MSG91 not configured — OTP logged to console.' };
  }

  /**
   * POST /integrations/test-sms — send a test OTP SMS to the given mobile (or
   * INTEGRATIONS_TEST_MOBILE). Reports success/failure rather than throwing, so
   * the admin sees the provider error verbatim.
   */
  @Post('test-sms')
  async testSms(@Body() body: { mobile?: string }): Promise<TestResult> {
    const mobile = body.mobile || this.config.get<string>('INTEGRATIONS_TEST_MOBILE');
    if (!mobile) {
      throw new BadRequestException(
        'provide a mobile in the body or set INTEGRATIONS_TEST_MOBILE',
      );
    }
    const live = this.has('MSG91_AUTH_KEY');
    try {
      await this.sms.sendOtp(mobile, '123456');
      return {
        ok: true,
        mode: live ? 'live' : 'dev-fallback',
        detail: live
          ? `Test OTP sent to ${mobile} via MSG91.`
          : `MSG91 not configured — OTP logged to server (dev fallback). No SMS sent.`,
      };
    } catch (err) {
      return {
        ok: false,
        mode: 'live',
        detail: (err as Error).message || 'MSG91 send failed.',
      };
    }
  }

  /**
   * POST /integrations/test-push — send a test push to a given FCM device token.
   */
  @Post('test-push')
  async testPush(@Body() body: { token?: string }): Promise<TestResult> {
    if (!body.token) throw new BadRequestException('token is required');
    const live = this.has('FCM_SERVICE_ACCOUNT_JSON') || this.has('FCM_SERVICE_ACCOUNT_PATH');
    try {
      await this.push.send(body.token, {
        title: 'Test notification',
        body: 'Patient Flow OS — push integration is working.',
        data: { type: 'TEST' },
      });
      return {
        ok: true,
        mode: live ? 'live' : 'dev-fallback',
        detail: live
          ? 'Test push dispatched via FCM.'
          : 'FCM not configured — push logged to server (dev fallback). No notification sent.',
      };
    } catch (err) {
      return {
        ok: false,
        mode: 'live',
        detail: (err as Error).message || 'FCM send failed.',
      };
    }
  }
}
