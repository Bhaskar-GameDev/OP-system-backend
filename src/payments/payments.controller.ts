import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { BookingSource } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AuthedRequest } from '../auth/jwt-auth.guard';
import { TenantService } from '../common/tenant/tenant.service';
import { InitiateBookingInput, PaymentsService } from './payments.service';

/** Request augmented with the raw body (needed for webhook signature verification). */
interface RawBodyRequest extends AuthedRequest {
  rawBody?: Buffer;
}

@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly tenant: TenantService,
  ) {}

  // staff/patient initiate a booking + order (auth required)
  @Post('booking')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('PATIENT', 'STAFF', 'ADMIN')
  async initiate(
    @Req() req: AuthedRequest,
    @Body() body: Partial<InitiateBookingInput>,
  ) {
    // Same-day model: no date / slot in the payload. The session is auto-resolved
    // to today's next-starting, not-yet-ended session inside initiateBooking.
    if (!body.patientId || !body.doctorId || !body.source) {
      throw new BadRequestException(
        'patientId, doctorId, source are required',
      );
    }
    // patientId/doctorId come from the request: a PATIENT may only book for
    // THEMSELVES, and staff may only book against a doctor in their own tenant.
    if (req.user?.role === 'PATIENT') {
      if (body.patientId !== req.user.sub) {
        throw new ForbiddenException('you may only book for yourself');
      }
    } else {
      await this.tenant.assertQueueAccess(req.user, body.doctorId);
    }
    return this.payments.initiateBooking({
      patientId: body.patientId,
      doctorId: body.doctorId,
      source: body.source as BookingSource,
    });
  }

  // entry path (a): Razorpay webhook — NO auth guard; verified by signature.
  @Post('webhook')
  async webhook(
    @Req() req: RawBodyRequest,
    @Headers('x-razorpay-signature') signature: string,
  ) {
    const raw = req.rawBody?.toString('utf8') ?? '';
    await this.payments.handleWebhook(raw, signature ?? '');
    return { received: true };
  }

  // entry path (b): client returned from checkout
  @Post('verify')
  async verify(
    @Body() body: { orderId?: string; paymentId?: string; signature?: string },
  ) {
    if (!body.orderId || !body.paymentId || !body.signature) {
      throw new BadRequestException('orderId, paymentId, signature are required');
    }
    return this.payments.verifyCheckout(body.orderId, body.paymentId, body.signature);
  }

  @Post('cancel')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('PATIENT', 'STAFF', 'ADMIN')
  async cancel(@Req() req: AuthedRequest, @Body() body: { bookingId?: string }) {
    if (!body.bookingId) throw new BadRequestException('bookingId is required');
    // bookingId is request-supplied: a patient may only cancel their OWN booking,
    // and staff only bookings inside their clinic/hospital.
    await this.tenant.assertBookingAccess(req.user, body.bookingId);
    return this.payments.cancelBooking(body.bookingId);
  }
}
