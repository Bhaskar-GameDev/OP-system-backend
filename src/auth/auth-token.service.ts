import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isProduction,
  jwtSecretProblem,
  ProductionConfigError,
} from '../common/config/production-config.validator';

export type Role = 'PATIENT' | 'DOCTOR' | 'STAFF' | 'ADMIN';

/**
 * Session-token claims. `sub` is the authenticated identity; each role carries
 * the scope it may access:
 *  - PATIENT -> sub = patientId (may access bookings they own); no tenant scope
 *  - DOCTOR  -> sub = doctorId, doctorId + clinicId + hospitalId set
 *  - STAFF   -> sub = staffId, clinicId + hospitalId set (their clinic)
 *  - ADMIN   -> sub = staffId, clinicId (home) + hospitalId set (hospital-wide)
 *
 * `hospitalId` is the tenant boundary for every staff/doctor role — the shared
 * enforcement layer (TenantService) filters all staff-side queries by it.
 */
export interface SessionClaims {
  sub: string;
  role: Role;
  doctorId?: string;
  clinicId?: string;
  hospitalId?: string;
  exp?: number; // unix seconds
}

/**
 * Minimal HMAC-signed token service. This is a SEAM: the real Auth Service
 * (Step 4) will replace it. Sockets and guards verify against this so the
 * realtime layer already enforces role-scoped access today.
 */
@Injectable()
export class AuthTokenService {
  private readonly secret: string;

  constructor(config: ConfigService) {
    const configured = config.get<string>('JWT_SECRET')?.trim();

    // Production has NO fallback. This used to default to 'dev_secret' — a
    // string published in this repository — which meant a missing JWT_SECRET
    // produced a fully functional server signing forgeable tokens for every
    // role. The bootstrap validator already refuses to start in that case; this
    // is the second lock, so any other entrypoint (worker, script, test harness
    // run with NODE_ENV=production) fails the same way.
    if (isProduction()) {
      const problem = jwtSecretProblem(configured);
      if (!configured) {
        throw new ProductionConfigError(
          'Production configuration validation failed: JWT_SECRET is missing.',
          ['JWT_SECRET'],
          [],
        );
      }
      if (problem) {
        throw new ProductionConfigError(
          `Production configuration validation failed: ${problem}.`,
          [],
          [problem],
        );
      }
    }

    // Development/test only: a deterministic local key so `npm test` and
    // `npm run start:dev` work without a .env. Unreachable in production by the
    // guard above.
    this.secret = configured || 'dev_secret';
  }

  sign(claims: SessionClaims, ttlSeconds = 3600): string {
    const payload: SessionClaims = {
      ...claims,
      exp: claims.exp ?? Math.floor(Date.now() / 1000) + ttlSeconds,
    };
    const body = b64url(JSON.stringify(payload));
    return `${body}.${this.mac(body)}`;
  }

  verify(token: string): SessionClaims {
    const dot = token.lastIndexOf('.');
    if (dot < 0) throw new UnauthorizedException('malformed token');

    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    const expected = this.mac(body);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('bad token signature');
    }

    let claims: SessionClaims;
    try {
      claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      throw new UnauthorizedException('unreadable token');
    }
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedException('token expired');
    }
    return claims;
  }

  private mac(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}
