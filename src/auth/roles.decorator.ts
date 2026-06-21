import { SetMetadata } from '@nestjs/common';
import { Role } from './auth-token.service';

export const ROLES_KEY = 'roles';

/** Declare the role(s) allowed to call an endpoint. Enforced by RolesGuard. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
