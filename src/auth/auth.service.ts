import { Injectable, UnauthorizedException } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuthTokenService, Role, SessionClaims } from './auth-token.service';
import { OtpService } from './otp.service';
import { PasswordService } from './password.service';
import { RefreshTokenService } from './refresh-token.service';
import { LoginThrottleService } from './login-throttle.service';
import { SessionRevocationService } from './session-revocation.service';
import { MetricsService } from '../common/observability/metrics.service';

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
    private readonly throttle: LoginThrottleService,
    private readonly revocation: SessionRevocationService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Sign an access token stamped with the principal's current session
   * generation. Every token is minted through here, because a token without a
   * generation cannot be placed relative to a later bulk revocation and is
   * therefore treated as revoked the moment one happens.
   */
  private async mint(claims: Omit<SessionClaims, 'gen'>): Promise<string> {
    const gen = await this.revocation.currentGeneration(claims.sub);
    return this.tokens.sign({ ...claims, gen });
  }

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

    const token = await this.mint({ sub: patient.id, role: 'PATIENT' });
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

    const token = await this.mint({ sub, role: 'PATIENT' });
    return { token, refreshToken: rotated };
  }

  /** Revoke a refresh token (logout). Idempotent. */
  async logoutPatient(refreshToken?: string, accessToken?: string): Promise<void> {
    await this.endSession(refreshToken, accessToken);
  }

  /**
   * Shared logout: kill the refresh token so no new access token can be minted,
   * and denylist the presented access token so the one already in the client's
   * hands stops working immediately rather than at its next expiry.
   *
   * Deliberately tolerant — a logout must succeed for an expired, malformed or
   * absent token. There is nothing to protect by refusing: the caller is asking
   * for less access, not more.
   */
  private async endSession(refreshToken?: string, accessToken?: string): Promise<void> {
    if (refreshToken) await this.refresh.revoke(refreshToken);
    if (!accessToken) return;
    try {
      await this.revocation.revokeToken(this.tokens.verify(accessToken));
    } catch {
      // unreadable, forged or already expired — nothing left to revoke
    }
  }

  // ── staff login (username/password) ──────────────────────
  async staffLogin(username: string, password: string, ip = ''): Promise<AuthResult> {
    // Checked before the lookup and before bcrypt, so a throttled attempt costs
    // a Redis read instead of a cost-12 hash.
    await this.throttle.assertNotThrottled('staff', username, ip);

    const staff = await this.prisma.staff.findUnique({
      where: { username },
      include: { hospital: { select: { name: true } } },
    });
    // compare even when not found is unnecessary here; reject uniformly
    if (!staff || !(await this.passwords.compare(password, staff.loginCredentials))) {
      // Counted for unknown usernames too, so a failure is indistinguishable
      // from one against a real account.
      await this.throttle.recordFailure('staff', username, ip);
      // Counted here rather than at the HTTP layer: a 401 on the login route is
      // the signal an operator alerts on, and it must be distinguishable from
      // the 401s an expired session produces everywhere else.
      this.metrics.authFailures.inc({ scope: 'staff', reason: 'invalid_credentials' });
      throw new UnauthorizedException('invalid credentials');
    }
    await this.throttle.recordSuccess('staff', username);
    // staff role maps to a coarse RBAC role
    const role: Role = staff.role === StaffRole.ADMIN ? 'ADMIN' : 'STAFF';
    const token = await this.mint({
      sub: staff.id,
      role,
      clinicId: staff.clinicId,
      hospitalId: staff.hospitalId,
    });
    // Staff sessions are revocable now: the refresh token is the server-side
    // handle, so logout, a password change or deactivation can end them.
    const refreshToken = await this.refresh.issue(staff.id, 'STAFF');
    return {
      token,
      refreshToken,
      role,
      sub: staff.id,
      hospitalId: staff.hospitalId,
      hospitalName: staff.hospital.name,
    };
  }

  /** Exchange a STAFF refresh token for a fresh access token (and rotate it). */
  async refreshStaffSession(refreshToken: string): Promise<AuthResult> {
    const { sub, refreshToken: rotated } = await this.refresh.verifyAndRotate(
      refreshToken,
      'STAFF',
    );

    const staff = await this.prisma.staff.findUnique({
      where: { id: sub },
      include: { hospital: { select: { name: true } } },
    });
    // A deleted account's refresh token is dropped by revokeAllForSubject, but
    // check anyway: this is the path that would otherwise re-mint access for a
    // principal that no longer exists.
    if (!staff) throw new UnauthorizedException('account no longer exists');

    const role: Role = staff.role === StaffRole.ADMIN ? 'ADMIN' : 'STAFF';
    const token = await this.mint({
      sub: staff.id,
      role,
      clinicId: staff.clinicId,
      hospitalId: staff.hospitalId,
    });
    return {
      token,
      refreshToken: rotated,
      role,
      sub: staff.id,
      hospitalId: staff.hospitalId,
      hospitalName: staff.hospital.name,
    };
  }

  /** Staff logout — revokes both the refresh token and the presented session. */
  async logoutStaff(refreshToken?: string, accessToken?: string): Promise<void> {
    await this.endSession(refreshToken, accessToken);
  }

  // ── doctor login (username/password) ─────────────────────
  async doctorLogin(username: string, password: string, ip = ''): Promise<AuthResult> {
    await this.throttle.assertNotThrottled('doctor', username, ip);

    const doctor = await this.prisma.doctor.findUnique({
      where: { username },
      include: { clinic: { select: { hospitalId: true, hospital: { select: { name: true } } } } },
    });
    if (
      !doctor ||
      !doctor.passwordHash ||
      !(await this.passwords.compare(password, doctor.passwordHash))
    ) {
      await this.throttle.recordFailure('doctor', username, ip);
      this.metrics.authFailures.inc({ scope: 'doctor', reason: 'invalid_credentials' });
      throw new UnauthorizedException('invalid credentials');
    }
    await this.throttle.recordSuccess('doctor', username);
    const hospitalId = doctor.clinic.hospitalId;
    const token = await this.mint({
      sub: doctor.id,
      role: 'DOCTOR',
      doctorId: doctor.id,
      clinicId: doctor.clinicId,
      hospitalId,
    });
    const refreshToken = await this.refresh.issue(doctor.id, 'DOCTOR');
    return {
      token,
      refreshToken,
      role: 'DOCTOR',
      sub: doctor.id,
      hospitalId,
      hospitalName: doctor.clinic.hospital.name,
    };
  }

  /** Exchange a DOCTOR refresh token for a fresh access token (and rotate it). */
  async refreshDoctorSession(refreshToken: string): Promise<AuthResult> {
    const { sub, refreshToken: rotated } = await this.refresh.verifyAndRotate(
      refreshToken,
      'DOCTOR',
    );

    const doctor = await this.prisma.doctor.findUnique({
      where: { id: sub },
      include: {
        clinic: { select: { hospitalId: true, hospital: { select: { name: true } } } },
      },
    });
    if (!doctor) throw new UnauthorizedException('account no longer exists');
    // A doctor whose login was withdrawn (password cleared by an admin) must not
    // be able to keep a session alive by refreshing it.
    if (!doctor.passwordHash) throw new UnauthorizedException('login disabled');

    const hospitalId = doctor.clinic.hospitalId;
    const token = await this.mint({
      sub: doctor.id,
      role: 'DOCTOR',
      doctorId: doctor.id,
      clinicId: doctor.clinicId,
      hospitalId,
    });
    return {
      token,
      refreshToken: rotated,
      role: 'DOCTOR',
      sub: doctor.id,
      hospitalId,
      hospitalName: doctor.clinic.hospital.name,
    };
  }

  /** Doctor logout — revokes both the refresh token and the presented session. */
  async logoutDoctor(refreshToken?: string, accessToken?: string): Promise<void> {
    await this.endSession(refreshToken, accessToken);
  }

  /**
   * End every session belonging to a principal, in both layers: the access
   * tokens already issued (revocation epoch) and the refresh tokens that could
   * mint new ones. Called on password change, deactivation and deletion — the
   * cases where the operator's intent is that existing sessions stop, and where
   * they have no way to enumerate the sessions themselves.
   */
  async revokeAllSessionsFor(sub: string): Promise<void> {
    await Promise.all([
      this.revocation.revokeAllForSubject(sub),
      this.refresh.revokeAllForSubject(sub),
    ]);
  }
}
