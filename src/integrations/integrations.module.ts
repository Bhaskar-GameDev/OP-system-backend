import { Module } from '@nestjs/common';
import { Msg91SmsSender, SMS_SENDER } from '../auth/sms.sender';
import { FcmPushSender, PUSH_SENDER } from '../notifications/push.sender';
import { IntegrationsController } from './integrations.controller';

/**
 * Admin operational surface for the external integrations (MSG91 / Razorpay /
 * FCM). Provides its OWN SMS/push sender instances using the same impl classes
 * as production, so test sends exercise the identical live-vs-dev-fallback path
 * without reaching into the auth/notifications module internals.
 */
@Module({
  controllers: [IntegrationsController],
  providers: [
    { provide: SMS_SENDER, useClass: Msg91SmsSender },
    { provide: PUSH_SENDER, useClass: FcmPushSender },
  ],
})
export class IntegrationsModule {}
