import { Injectable, UnauthorizedException } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuthTokenService, Role } from './auth-token.service';
import { OtpService } from './otp.service';
import { PasswordService } from './password.service';

export interface AuthResult {
  token: string;
  role: Role;
  sub: string;
}

/**
 * Auth orchestration:
 *  - patients authenticate by OTP (MSG91), identified by mobile
 *  - staff & doctors authenticate by username/password (bcrypt)
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AuthTokenService,
    private readonly otp: OtpService,
    private readonly passwords: PasswordService,
  ) {}

  // ── patient OTP ──────────────────────────────────────────
  requestPatientOtp(mobile: string): Promise<void> {
    return this.otp.requestOtp(mobile);
  }

  /** Verify OTP, upsert the patient by mobile, issue a PATIENT token. */
  async verifyPatientOtp(mobile: string, code: string): Promise<AuthResult> {
    await this.otp.verifyOtp(mobile, code); // throws on failure/lockout

    const patient = await this.prisma.patient.upsert({
      where: { mobile },
      create: { mobile, name: '' },
      update: {},
    });

    const token = this.tokens.sign({ sub: patient.id, role: 'PATIENT' });
    return { token, role: 'PATIENT', sub: patient.id };
  }

  // ── staff login (username/password) ──────────────────────
  async staffLogin(username: string, password: string): Promise<AuthResult> {
    const staff = await this.prisma.staff.findUnique({ where: { username } });
    // compare even when not found is unnecessary here; reject uniformly
    if (!staff || !(await this.passwords.compare(password, staff.loginCredentials))) {
      throw new UnauthorizedException('invalid credentials');
    }
    // staff role maps to a coarse RBAC role
    const role: Role = staff.role === StaffRole.ADMIN ? 'ADMIN' : 'STAFF';
    const token = this.tokens.sign({
      sub: staff.id,
      role,
      clinicId: staff.clinicId,
    });
    return { token, role, sub: staff.id };
  }

  // ── doctor login (username/password) ─────────────────────
  async doctorLogin(username: string, password: string): Promise<AuthResult> {
    const doctor = await this.prisma.doctor.findUnique({ where: { username } });
    if (
      !doctor ||
      !doctor.passwordHash ||
      !(await this.passwords.compare(password, doctor.passwordHash))
    ) {
      throw new UnauthorizedException('invalid credentials');
    }
    const token = this.tokens.sign({
      sub: doctor.id,
      role: 'DOCTOR',
      doctorId: doctor.id,
      clinicId: doctor.clinicId,
    });
    return { token, role: 'DOCTOR', sub: doctor.id };
  }
}
