import { BadRequestException, Body, Controller, Headers, Ip, Post } from '@nestjs/common';
import { AuthService } from './auth.service';

/** `Authorization: Bearer <access token>` -> the raw token, if present. */
function bearer(header?: string): string | undefined {
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

interface OtpRequestDto {
  mobile?: string;
}
interface OtpVerifyDto {
  mobile?: string;
  otp?: string;
}
interface LoginDto {
  username?: string;
  password?: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('patient/otp/request')
  async requestOtp(@Body() body: OtpRequestDto) {
    if (!body?.mobile) throw new BadRequestException('mobile is required');
    await this.auth.requestPatientOtp(body.mobile);
    return { sent: true };
  }

  @Post('patient/otp/verify')
  async verifyOtp(@Body() body: OtpVerifyDto) {
    if (!body?.mobile || !body?.otp) {
      throw new BadRequestException('mobile and otp are required');
    }
    return this.auth.verifyPatientOtp(body.mobile, body.otp);
  }

  @Post('patient/refresh')
  async refreshPatient(@Body() body: { refreshToken?: string }) {
    if (!body?.refreshToken) {
      throw new BadRequestException('refreshToken is required');
    }
    return this.auth.refreshPatientSession(body.refreshToken);
  }

  /**
   * Logout is deliberately unguarded and always answers `ok`. It takes the
   * access token from the header when one is sent, so the presented session is
   * denylisted as well as the refresh token dropped — but an expired or missing
   * token must not turn "log me out" into a 401.
   */
  @Post('patient/logout')
  async logoutPatient(
    @Body() body: { refreshToken?: string },
    @Headers('authorization') authorization?: string,
  ) {
    await this.auth.logoutPatient(body?.refreshToken, bearer(authorization));
    return { ok: true };
  }

  /**
   * Privileged login. `@Ip()` feeds the brute-force throttle — it reads
   * `req.ip`, which resolves the real client address through Caddy because
   * `trust proxy` is enabled in main.ts. Without that it would be the proxy's
   * address for every request and the per-IP counter would be useless.
   */
  @Post('staff/login')
  async staffLogin(@Body() body: LoginDto, @Ip() ip: string) {
    if (!body?.username || !body?.password) {
      throw new BadRequestException('username and password are required');
    }
    return this.auth.staffLogin(body.username, body.password, ip);
  }

  @Post('staff/refresh')
  async refreshStaff(@Body() body: { refreshToken?: string }) {
    if (!body?.refreshToken) {
      throw new BadRequestException('refreshToken is required');
    }
    return this.auth.refreshStaffSession(body.refreshToken);
  }

  @Post('staff/logout')
  async logoutStaff(
    @Body() body: { refreshToken?: string },
    @Headers('authorization') authorization?: string,
  ) {
    await this.auth.logoutStaff(body?.refreshToken, bearer(authorization));
    return { ok: true };
  }

  @Post('doctor/login')
  async doctorLogin(@Body() body: LoginDto, @Ip() ip: string) {
    if (!body?.username || !body?.password) {
      throw new BadRequestException('username and password are required');
    }
    return this.auth.doctorLogin(body.username, body.password, ip);
  }

  @Post('doctor/refresh')
  async refreshDoctor(@Body() body: { refreshToken?: string }) {
    if (!body?.refreshToken) {
      throw new BadRequestException('refreshToken is required');
    }
    return this.auth.refreshDoctorSession(body.refreshToken);
  }

  @Post('doctor/logout')
  async logoutDoctor(
    @Body() body: { refreshToken?: string },
    @Headers('authorization') authorization?: string,
  ) {
    await this.auth.logoutDoctor(body?.refreshToken, bearer(authorization));
    return { ok: true };
  }
}
