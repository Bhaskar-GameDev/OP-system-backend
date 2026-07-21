import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PushPlatform } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuthedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

/** Wire values accepted for the platform field — lowercase, as the app sends them. */
const PLATFORMS: Record<string, PushPlatform> = {
  android: PushPlatform.ANDROID,
  ios: PushPlatform.IOS,
};

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Register the caller's FCM registration token against their patient account
   * so the backend knows where to push. Captured at login / app-open. PATIENT
   * only — the device belongs to the authenticated patient (sub from the JWT).
   *
   * `platform` tells the sender which FCM message shape to build (iOS needs an
   * apns block to carry sound/badge). It is OPTIONAL: an app build predating it
   * simply omits it, and a null platform is read as Android everywhere, which is
   * correct because iOS push did not work before this field existed.
   */
  @Post('device')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('PATIENT')
  async registerDevice(
    @Req() req: AuthedRequest,
    @Body() body: { fcmToken?: unknown; platform?: unknown },
  ): Promise<{ registered: boolean }> {
    const { fcmToken } = body;
    if (typeof fcmToken !== 'string' || fcmToken.trim().length === 0) {
      throw new BadRequestException('fcmToken is required');
    }

    let pushPlatform: PushPlatform | null = null;
    if (body.platform !== undefined && body.platform !== null) {
      if (typeof body.platform !== 'string' || !(body.platform in PLATFORMS)) {
        throw new BadRequestException("platform must be 'android' or 'ios'");
      }
      pushPlatform = PLATFORMS[body.platform];
    }

    const patientId = req.user?.sub;
    if (!patientId) throw new BadRequestException('missing patient identity');

    await this.prisma.patient.update({
      where: { id: patientId },
      data: { fcmToken: fcmToken.trim(), pushPlatform },
    });
    return { registered: true };
  }
}
