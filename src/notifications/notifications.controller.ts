import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuthedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Register the caller's FCM device token against their patient account so the
   * backend knows where to push. Captured at login / app-open. PATIENT only —
   * the device belongs to the authenticated patient (sub from the JWT).
   */
  @Post('device')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('PATIENT')
  async registerDevice(
    @Req() req: AuthedRequest,
    @Body() body: { fcmToken?: string },
  ): Promise<{ registered: boolean }> {
    if (!body.fcmToken) throw new BadRequestException('fcmToken is required');
    const patientId = req.user?.sub;
    if (!patientId) throw new BadRequestException('missing patient identity');

    await this.prisma.patient.update({
      where: { id: patientId },
      data: { fcmToken: body.fcmToken },
    });
    return { registered: true };
  }
}
