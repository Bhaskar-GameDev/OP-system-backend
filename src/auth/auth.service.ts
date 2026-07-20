import { Injectable, UnauthorizedException } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuthTokenService, Role } from './auth-token.service';
import { OtpService } from './otp.service';
import { PasswordService } from './password.service';
import { RefreshTokenService } from './refresh-token.service';

export interface AuthResult {
  token: string;
  role: Role;
  sub: string;
  refreshToken?: string;
  // Staff/doctor only — surfaced so the desktop apps can show the tenant in the
  // header. Patients are cross-hospital and never carry one.
  hospitalId?: string;
  hospitalName?: string;
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
    private readonly refresh: RefreshTokenService,
  ) {}

  // ── patient OTP ──────────────────────────────────────────
  requestPatientOtp(mobile: string): Promise<void> {
    return this.otp.requestOtp(mobile);
  }

  /**
   * Verify OTP, upsert the patient by mobile, issue a short-lived PATIENT
   * access token plus a long-lived rotating refresh token.
   */
  async verifyPatientOtp(mobile: string, code: string): Promise<AuthResult> {
    await this.otp.verifyOtp(mobile, code); // throws on failure/lockout

    const patient = await this.prisma.patient.upsert({
      where: { mobile },
      create: { mobile, name: '' },
      update: {},
    });

    const token = this.tokens.sign({ sub: patient.id, role: 'PATIENT' });
    const refreshToken = await this.refresh.issue(patient.id);
    return { token, refreshToken, role: 'PATIENT', sub: patient.id };
  }

  /**
   * Exchange a valid refresh token for a new access token (and a rotated
   * refresh token). The app calls this transparently when its access token
   * expires, so the patient never re-enters an OTP until the refresh token
   * itself lapses (30d) or is revoked.
   */
  async refreshPatientSession(
    refreshToken: string,
  ): Promise<{ token: string; refreshToken: string }> {
    const { sub, refreshToken: rotated } =
      await this.refresh.verifyAndRotate(refreshToken);

    const patient = await this.prisma.patient.findUnique({ where: { id: sub } });
    if (!patient) throw new UnauthorizedException('account no longer exists');

    const token = this.tokens.sign({ sub, role: 'PATIENT' });
    return { token, refreshToken: rotated };
  }

  /** Revoke a refresh token (logout). Idempotent. */
  async logoutPatient(refreshToken: string): Promise<void> {
    await this.refresh.revoke(refreshToken);
  }

  // ── staff login (username/password) ──────────────────────
  async staffLogin(username: string, password: string): Promise<AuthResult> {
    const staff = await this.prisma.staff.findUnique({
      where: { username },
      include: { hospital: { select: { name: true } } },
    });
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
      hospitalId: staff.hospitalId,
    });
    return {
      token,
      role,
      sub: staff.id,
      hospitalId: staff.hospitalId,
      hospitalName: staff.hospital.name,
    };
  }

  // ── doctor login (username/password) ─────────────────────
  async doctorLogin(username: string, password: string): Promise<AuthResult> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { username },
      include: { clinic: { select: { hospitalId: true, hospital: { select: { name: true } } } } },
    });
    if (
      !doctor ||
      !doctor.passwordHash ||
      !(await this.passwords.compare(password, doctor.passwordHash))
    ) {
      throw new UnauthorizedException('invalid credentials');
    }
    const hospitalId = doctor.clinic.hospitalId;
    const token = this.tokens.sign({
      sub: doctor.id,
      role: 'DOCTOR',
      doctorId: doctor.id,
      clinicId: doctor.clinicId,
      hospitalId,
    });
    return {
      token,
      role: 'DOCTOR',
      sub: doctor.id,
      hospitalId,
      hospitalName: doctor.clinic.hospital.name,
    };
  }
}
