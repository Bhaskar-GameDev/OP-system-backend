import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { VoiceInternalGuard } from './voice-internal.guard';
import { VoiceService } from './voice.service';
import {
  BookDto,
  CallLogDto,
  CancelAppointmentDto,
  LookupAppointmentsDto,
  SearchAvailabilityDto,
} from './voice.dto';

/**
 * Internal Voice API — consumed ONLY by the standalone hospital-voice-agent
 * process, authenticated by the shared `x-voice-secret` header (NOT JWT; there
 * is no logged-in user on a phone call). Everything is POST + JSON so the agent
 * has one uniform call shape.
 */
@Controller('voice')
@UseGuards(VoiceInternalGuard)
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  /** Doctors matching a specialty + live queue load per session for a date. */
  @Post('availability')
  searchAvailability(@Body() body: SearchAvailabilityDto) {
    return this.voice.searchAvailability(body);
  }

  /** Create a VOICE booking (issues a token immediately, like a walk-in). */
  @Post('bookings')
  book(@Body() body: BookDto) {
    return this.voice.book(body);
  }

  /** Upcoming live bookings for a caller (by phone) — for cancel/reschedule. */
  @Post('appointments/lookup')
  lookup(@Body() body: LookupAppointmentsDto) {
    return this.voice.findAppointments(body);
  }

  /** Cancel a booking by id. */
  @Post('appointments/cancel')
  cancel(@Body() body: CancelAppointmentDto) {
    return this.voice.cancel(body);
  }

  /** Persist the full call transcript/outcome (keyed by callSid). */
  @Post('call-logs')
  callLog(@Body() body: CallLogDto) {
    return this.voice.saveCallLog(body);
  }
}
