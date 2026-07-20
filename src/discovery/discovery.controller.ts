import { Controller, Get, Param, Query } from '@nestjs/common';
import { DiscoveryService } from './discovery.service';

/**
 * Public discovery — NO auth guard. Clinic/doctor search + profile lookups for
 * the Patient App. Every response is an explicit public DTO (see discovery.dto).
 */
@Controller()
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Get('clinics')
  searchClinics(
    @Query('query') query = '',
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.discovery.searchClinics(query, toInt(page), toInt(pageSize));
  }

  @Get('clinics/:id')
  getClinic(@Param('id') id: string) {
    return this.discovery.getClinic(id);
  }

  @Get('doctors')
  searchDoctors(
    @Query('query') query = '',
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.discovery.searchDoctors(query, toInt(page), toInt(pageSize));
  }

  @Get('doctors/:id')
  getDoctor(@Param('id') id: string) {
    return this.discovery.getDoctor(id);
  }

  /** Public weekly schedule + next-7-days availability (tokens issued vs max). */
  @Get('doctors/:id/schedule')
  getDoctorSchedule(@Param('id') id: string) {
    return this.discovery.getDoctorSchedule(id);
  }

  /**
   * Same-day model: the session the patient would join right now (time window +
   * fee), or whether none remains today. Powers the "Join Queue" screen.
   */
  @Get('doctors/:id/today')
  getTodaySession(@Param('id') id: string) {
    return this.discovery.getTodaySession(id);
  }
}

function toInt(v?: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
