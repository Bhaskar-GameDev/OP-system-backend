import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { OpPaymentMode } from '@prisma/client';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { AuthedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { SessionClaims } from '../auth/auth-token.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { TenantService } from '../common/tenant/tenant.service';
import { OpPaymentService } from './op-payment.service';

class OnlineOrderBody {
  @IsOptional() @IsInt() @Min(1) amount?: number;
}
class ConfirmBody {
  @IsString() razorpayPaymentId!: string;
  @IsString() signature!: string;
}
class DeskBody {
  @IsIn(['CASH', 'UPI_DESK', 'CORPORATE_BILL', 'WAIVED'])
  mode!: OpPaymentMode;
  @IsOptional() @IsInt() @Min(0) amount?: number;
}

/**
 * Decoupled OP payments (ARCHITECTURE.md §3.2). Payment NEVER gates a token, so
 * this surface is intentionally separate from the token/queue endpoints. Mixed
 * audience — a patient may pay online for their OWN encounter; reception settles
 * at the desk — so visibility is checked per handler rather than with the
 * staff-only TenantScopeGuard (patients carry no hospital scope).
 */
@Controller('op')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OpPaymentController {
  constructor(
    private readonly payments: OpPaymentService,
    private readonly tenant: TenantService,
    private readonly prisma: PrismaService,
  ) {}

  /** POST /op/encounters/:id/payments/online — create a Razorpay order (pay before). */
  @Post('encounters/:id/payments/online')
  @Roles('PATIENT', 'STAFF', 'ADMIN')
  async online(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: OnlineOrderBody,
  ) {
    await this.assertEncounterVisibility(req.user, id);
    return this.payments.createOnlineOrder(id, { amount: body.amount });
  }

  /** POST /op/payments/:opPaymentId/confirm — confirm an online payment. */
  @Post('payments/:opPaymentId/confirm')
  @Roles('PATIENT', 'STAFF', 'ADMIN')
  async confirm(
    @Req() req: AuthedRequest,
    @Param('opPaymentId') opPaymentId: string,
    @Body() body: ConfirmBody,
  ) {
    const payment = await this.prisma.opPayment.findUnique({
      where: { id: opPaymentId },
      select: { encounterId: true },
    });
    if (!payment) throw new NotFoundException('payment not found');
    await this.assertEncounterVisibility(req.user, payment.encounterId);
    return this.payments.confirmOnline({
      opPaymentId,
      razorpayPaymentId: body.razorpayPaymentId,
      signature: body.signature,
    });
  }

  /** POST /op/encounters/:id/payments/desk — reception settles cash/UPI/etc. */
  @Post('encounters/:id/payments/desk')
  @Roles('STAFF', 'ADMIN')
  async desk(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: DeskBody,
  ) {
    await this.tenant.assertEncounterAccess(req.user, id);
    return this.payments.settleAtDesk(id, body.mode, {
      amount: body.amount,
      actorId: req.user?.sub,
    });
  }

  /** GET /op/encounters/:id/payments — payments recorded against an encounter. */
  @Get('encounters/:id/payments')
  @Roles('PATIENT', 'STAFF', 'ADMIN', 'DOCTOR')
  async list(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.assertEncounterVisibility(req.user, id);
    return this.payments.forEncounter(id);
  }

  /** Patient may act on their OWN encounter; staff/doctor via tenant scope. */
  private async assertEncounterVisibility(
    claims: SessionClaims | undefined,
    encounterId: string,
  ): Promise<void> {
    if (!claims) throw new ForbiddenException('missing identity');
    if (claims.role === 'PATIENT') {
      const enc = await this.prisma.encounter.findUnique({
        where: { id: encounterId },
        select: { patientId: true },
      });
      if (!enc || enc.patientId !== claims.sub) {
        throw new NotFoundException('encounter not found'); // no existence leak
      }
      return;
    }
    await this.tenant.assertEncounterAccess(claims, encounterId);
  }
}
