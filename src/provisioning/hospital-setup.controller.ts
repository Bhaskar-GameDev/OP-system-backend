import { Body, Controller, Get, Ip, Post } from '@nestjs/common';
import { HospitalSetupService } from './hospital-setup.service';
import {
  HospitalSetupInput,
  HospitalSetupResult,
  HospitalSetupStatus,
} from './hospital-setup.dto';

/**
 * Tenant bootstrap, driven by the reception app's "Set up hospital" screen.
 *
 * UNGUARDED by construction — there is no token to present before the first
 * hospital exists. The gate is the `HOSPITAL_SETUP_KEY` check inside
 * HospitalSetupService, which also disables the route entirely when the key is
 * not configured. Do NOT add anything else to this controller: it is the only
 * unauthenticated write surface outside patient OTP, and it should stay a single
 * purpose that is easy to audit.
 */
@Controller('setup')
export class HospitalSetupController {
  constructor(private readonly setup: HospitalSetupService) {}

  /**
   * GET /setup/status — may the desk offer the setup screen? Reveals only
   * whether the key is configured, never any part of it. Without this the login
   * screen would show a button that dead-ends in a 404 on every deployment that
   * has setup switched off.
   */
  @Get('status')
  status(): HospitalSetupStatus {
    return this.setup.status();
  }

  /**
   * POST /setup/hospital — create hospital + first clinic + first ADMIN.
   * `@Ip()` feeds the brute-force throttle on the setup key; it resolves the real
   * client address because `trust proxy` is set in main.ts.
   */
  @Post('hospital')
  create(
    @Body() body: HospitalSetupInput,
    @Ip() ip: string,
  ): Promise<HospitalSetupResult> {
    return this.setup.createHospital(body ?? {}, ip);
  }
}
