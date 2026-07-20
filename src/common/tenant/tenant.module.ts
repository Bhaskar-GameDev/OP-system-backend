import { Global, Module } from '@nestjs/common';
import { TenantService } from './tenant.service';

/**
 * Global so every staff-side module (admin, reports, analytics, audit, queue)
 * can inject the shared isolation helper without per-module import wiring —
 * keeping enforcement centralized rather than re-implemented per feature.
 */
@Global()
@Module({
  providers: [TenantService],
  exports: [TenantService],
})
export class TenantModule {}
