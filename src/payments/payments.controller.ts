import {
  BadRequestException,
  Body,
  Controller,
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
import { InitiateBookingInput, PaymentsService } from './payments.service';

/** Request augmented with the raw body (needed for webhook signature verification). */
interface RawBodyRequest extends AuthedRequest {
  rawBody?: Buffer;
}

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  // staff/patient initiate a booking + order (auth required)
  @Post('booking')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('PATIENT', 'STAFF', 'ADMIN')
  async initiate(@Body() body: Partial<InitiateBookingInput>) {
    if (
      !body.patientId ||
      !body.doctorId ||
      !body.sessionDate ||
      !body.sessionType ||
      !body.source
    ) {
      throw new BadRequestException(
        'patientId, doctorId, sessionDate, sessionType, source are required',
      );
    }
    return this.payments.initiateBooking({
      patientId: body.patientId,
      doctorId: body.doctorId,
      sessionDate: body.sessionDate,
      sessionType: body.sessionType,
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
  async cancel(@Body() body: { bookingId?: string }) {
    if (!body.bookingId) throw new BadRequestException('bookingId is required');
    return this.payments.cancelBooking(body.bookingId);
  }
}
