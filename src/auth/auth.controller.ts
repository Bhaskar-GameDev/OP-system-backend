import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';

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

  @Post('staff/login')
  async staffLogin(@Body() body: LoginDto) {
    if (!body?.username || !body?.password) {
      throw new BadRequestException('username and password are required');
    }
    return this.auth.staffLogin(body.username, body.password);
  }

  @Post('doctor/login')
  async doctorLogin(@Body() body: LoginDto) {
    if (!body?.username || !body?.password) {
      throw new BadRequestException('username and password are required');
    }
    return this.auth.doctorLogin(body.username, body.password);
  }
}
