import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { VoiceSecretGuard } from './voice-secret.guard';
import { VoiceService } from './voice.service';
import {
  VoiceAvailabilityRequest,
  VoiceBookingRequest,
  VoiceCallLogRequest,
  VoiceCancelRequest,
  VoiceLookupRequest,
  VoiceQueueStatusRequest,
} from './voice.dto';

/**
 * Internal Voice API consumed by the voice agent (`hospital-voice-agent`). Not a
 * user-facing surface — authed by the shared `x-voice-secret` header, never a
 * JWT. Tenant routing is by the inbound DID inside the service.
 */
@Controller('voice')
@UseGuards(VoiceSecretGuard)
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  @Post('availability')
  availability(@Body() body: VoiceAvailabilityRequest) {
    if (!body?.didNumber) throw new BadRequestException('didNumber is required');
    return this.voice.availability(body);
  }

  @Post('bookings')
  book(@Body() body: VoiceBookingRequest) {
    if (!body?.didNumber || !body?.doctorId || !body?.sessionType || !body?.patientPhone || !body?.callSid) {
      throw new BadRequestException('didNumber, doctorId, sessionType, patientPhone, callSid are required');
    }
    return this.voice.book(body);
  }

  @Post('appointments/lookup')
  lookup(@Body() body: VoiceLookupRequest) {
    if (!body?.didNumber || !body?.patientPhone) {
      throw new BadRequestException('didNumber and patientPhone are required');
    }
    return this.voice.lookup(body);
  }

  @Post('appointments/cancel')
  cancel(@Body() body: VoiceCancelRequest) {
    if (!body?.appointmentId) throw new BadRequestException('appointmentId is required');
    return this.voice.cancel(body.appointmentId);
  }

  /**
   * Live position for the caller's own tokens. POST like the rest of this API
   * (it carries a phone number, which has no business in a query string or an
   * access log). An empty array means "no live booking" — never a 404, so the
   * agent can say the right thing.
   */
  @Post('queue-status')
  queueStatus(@Body() body: VoiceQueueStatusRequest) {
    if (!body?.didNumber || !body?.patientPhone) {
      throw new BadRequestException('didNumber and patientPhone are required');
    }
    return this.voice.queueStatus(body);
  }

  @Post('call-logs')
  callLog(@Body() body: VoiceCallLogRequest) {
    if (!body?.callSid) throw new BadRequestException('callSid is required');
    return this.voice.saveCallLog(body);
  }
}
