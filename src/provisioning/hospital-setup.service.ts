import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StaffRole } from '@prisma/client';
import { timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { provisionClinicOpConfig } from '../common/provisioning/clinic-op-config';
import { PasswordService } from '../auth/password.service';
import { LoginThrottleService } from '../auth/login-throttle.service';
import {
  HospitalSetupInput,
  HospitalSetupResult,
  HospitalSetupStatus,
} from './hospital-setup.dto';

/** Throttle scope, so setup-key guessing shares no counter with staff logins. */
const THROTTLE_SCOPE = 'hospital-setup';
/** Constant identifier: there is one key, so the per-identifier counter is global. */
const THROTTLE_ID = 'setup-key';

const MIN_PASSWORD_LENGTH = 10;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

/**
 * Tenant bootstrap for the desk app's "Set up hospital" screen — the one thing
 * `/admin/*` cannot do, because every admin route derives its hospital from the
 * caller's token and so needs an admin of that hospital to already exist.
 *
 * This route is UNAUTHENTICATED by necessity, which makes it the most sensitive
 * surface in the backend: it mints a tenant and an ADMIN login. Four controls:
 *
 *  1. DISABLED unless `HOSPITAL_SETUP_KEY` is configured. An existing deployment
 *     that never sets it does not gain a new attack surface by upgrading, and the
 *     route answers 404 — not 403 — so it is indistinguishable from absent.
 *  2. The submitted key is compared in constant time; a wrong key is a 401 that
 *     says nothing else.
 *  3. Attempts run through the same brute-force throttle as privileged logins,
 *     under their own scope, so a key cannot be guessed at speed.
 *  4. Everything commits in ONE transaction: no half-made hospital with no admin,
 *     and no clinic without the token series it cannot issue tokens without.
 *
 * It never touches an existing hospital: a duplicate name or username is a 409.
 */
@Injectable()
export class HospitalSetupService {
  private readonly logger = new Logger(HospitalSetupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly passwords: PasswordService,
    private readonly throttle: LoginThrottleService,
  ) {}

  private get setupKey(): string {
    return (this.config.get<string>('HOSPITAL_SETUP_KEY') ?? '').trim();
  }

  /** Advertised to the login screen so it only offers a flow that can succeed. */
  status(): HospitalSetupStatus {
    return { enabled: this.setupKey.length > 0 };
  }

  async createHospital(
    input: HospitalSetupInput,
    ip: string,
  ): Promise<HospitalSetupResult> {
    const configured = this.setupKey;
    if (configured.length === 0) {
      // Not "forbidden" — the feature does not exist on this deployment.
      throw new NotFoundException('Cannot POST /setup/hospital');
    }

    await this.throttle.assertNotThrottled(THROTTLE_SCOPE, THROTTLE_ID, ip);
    if (!constantTimeEquals(input.setupKey ?? '', configured)) {
      await this.throttle.recordFailure(THROTTLE_SCOPE, THROTTLE_ID, ip);
      this.logger.warn('hospital setup rejected: invalid setup key');
      throw new UnauthorizedException('invalid setup key');
    }

    // Validate only AFTER the key check, so a bad key learns nothing about the
    // shape of a valid request.
    const fields = this.validate(input);
    await this.throttle.recordSuccess(THROTTLE_SCOPE, THROTTLE_ID);

    const [hospitalClash, usernameClash] = await Promise.all([
      this.prisma.hospital.findFirst({
        where: { name: fields.hospital },
        select: { id: true },
      }),
      this.prisma.staff.findUnique({
        where: { username: fields.adminUsername },
        select: { id: true },
      }),
    ]);
    if (hospitalClash) {
      throw new ConflictException(
        `a hospital named "${fields.hospital}" already exists`,
      );
    }
    if (usernameClash) {
      throw new ConflictException(
        `the username "${fields.adminUsername}" is already taken`,
      );
    }

    // Hash outside the transaction: bcrypt cost 12 is ~200ms and must not be
    // held open as a database transaction.
    const passwordHash = await this.passwords.hash(fields.adminPassword);

    const created = await this.prisma.$transaction(async (tx) => {
      const hospital = await tx.hospital.create({
        data: { name: fields.hospital },
        select: { id: true, name: true },
      });
      const clinic = await tx.clinic.create({
        data: {
          hospitalId: hospital.id,
          name: fields.clinic,
          address: fields.address,
          contactNumber: fields.contactNumber,
        },
        select: { id: true, name: true },
      });
      await provisionClinicOpConfig(tx, clinic.id);
      await tx.staff.create({
        data: {
          hospitalId: hospital.id,
          clinicId: clinic.id,
          name: fields.adminName,
          role: StaffRole.ADMIN,
          username: fields.adminUsername,
          loginCredentials: passwordHash,
        },
      });
      return { hospital, clinic };
    });

    // Names, never the key or the password. An operator needs to be able to see
    // that a tenant was provisioned and by which admin account.
    this.logger.log(
      `hospital provisioned: "${created.hospital.name}" (${created.hospital.id}) ` +
        `clinic "${created.clinic.name}" admin "${fields.adminUsername}"`,
    );

    return {
      hospitalId: created.hospital.id,
      hospitalName: created.hospital.name,
      clinicId: created.clinic.id,
      clinicName: created.clinic.name,
      adminUsername: fields.adminUsername,
    };
  }

  /**
   * Reject bad input before anything is written. The password rules matter more
   * here than anywhere else in the app: this screen mints the account that owns a
   * whole hospital, and nobody reviews what gets typed into it.
   */
  private validate(input: HospitalSetupInput): {
    hospital: string;
    clinic: string;
    address: string;
    contactNumber: string;
    adminUsername: string;
    adminName: string;
    adminPassword: string;
  } {
    const hospital = text(input.hospital, 'hospital', 2, 120);
    // A single-site hospital would only retype its own name, so an omitted
    // clinic name inherits the hospital's.
    const clinic = (input.clinic ?? '').trim()
      ? text(input.clinic, 'clinic', 2, 120)
      : hospital;
    const adminUsername = (input.adminUsername ?? '').trim().toLowerCase();
    const adminPassword = input.adminPassword ?? '';

    if (!USERNAME_PATTERN.test(adminUsername)) {
      throw new BadRequestException(
        'adminUsername must be 3-32 characters: lowercase letters, digits, dot, dash or underscore, starting with a letter or digit',
      );
    }
    if (adminPassword.length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestException(
        `adminPassword must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
    }
    if (adminPassword.toLowerCase().includes(adminUsername)) {
      throw new BadRequestException(
        'adminPassword must not contain the username',
      );
    }

    return {
      hospital,
      clinic,
      address: text(input.address, 'address', 4, 200),
      contactNumber: phone(input.contactNumber),
      adminUsername,
      adminName: (input.adminName ?? '').trim() || `${hospital} Admin`,
      adminPassword,
    };
  }
}

function text(value: string | undefined, field: string, min: number, max: number): string {
  const trimmed = (value ?? '').trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new BadRequestException(`${field} must be ${min}-${max} characters`);
  }
  return trimmed;
}

/**
 * A contact number the clinic can actually be reached on. Formatting is left
 * alone (+91, spaces, hyphens all differ by region) but there has to be a real
 * number in there — "n/a" or a stray dash is the same as no contact at all.
 */
function phone(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 6 || trimmed.length > 40) {
    throw new BadRequestException(
      'contactNumber must be a reachable number (at least 6 digits, at most 40 characters)',
    );
  }
  return trimmed;
}

/**
 * Constant-time string compare. `a === b` returns early on the first differing
 * byte, which leaks the shared prefix length to an attacker timing the endpoint.
 * Lengths are compared first (unavoidable, and not secret enough to matter) so
 * timingSafeEqual gets two equal-length buffers as it requires.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
