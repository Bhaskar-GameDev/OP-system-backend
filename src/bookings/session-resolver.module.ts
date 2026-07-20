import { Module } from '@nestjs/common';
import { SessionResolverService } from './session-resolver.service';

// Same-day session auto-resolution. Standalone (only needs the global Prisma
// module) so both PaymentsModule (booking path) and DiscoveryModule (public
// "today" endpoint) can import it without a circular dependency.
@Module({
  providers: [SessionResolverService],
  exports: [SessionResolverService],
})
export class SessionResolverModule {}
