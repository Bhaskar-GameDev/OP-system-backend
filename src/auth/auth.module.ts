import { Global, Module } from '@nestjs/common';
import { AuthTokenService } from './auth-token.service';
import { AuthService } from './auth.service';
import { RefreshTokenService } from './refresh-token.service';
import { SessionRevocationService } from './session-revocation.service';
import { LoginThrottleService } from './login-throttle.service';
import { OtpService } from './otp.service';
import { PasswordService } from './password.service';
import { Msg91SmsSender, SMS_SENDER } from './sms.sender';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { AuthController } from './auth.controller';

// Step 4 — Auth Service. Patient OTP (MSG91), staff/doctor username+password
// (bcrypt), session tokens, and the RBAC guards used across the app.
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    AuthTokenService,
    AuthService,
    RefreshTokenService,
    SessionRevocationService,
    LoginThrottleService,
    OtpService,
    PasswordService,
    JwtAuthGuard,
    RolesGuard,
    { provide: SMS_SENDER, useClass: Msg91SmsSender },
  ],
  exports: [
    AuthTokenService,
    AuthService,
    SessionRevocationService,
    // Exported so the hospital-setup route can throttle setup-key guessing with
    // the same control that protects privileged logins.
    LoginThrottleService,
    PasswordService,
    JwtAuthGuard,
    RolesGuard,
  ],
})
export class AuthModule {}
