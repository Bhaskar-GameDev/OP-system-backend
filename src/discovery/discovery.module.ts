import { Module } from '@nestjs/common';
import { DiscoveryService } from './discovery.service';
import { DiscoveryController } from './discovery.controller';
import { SessionResolverModule } from '../bookings/session-resolver.module';

// Patient App backend dep — public clinic/doctor discovery. No auth.
// Session availability is derived from live booking counts (Postgres), so a
// cancelled booking reopens the slot. The same-day "today" endpoint reuses the
// shared SessionResolver.
@Module({
  imports: [SessionResolverModule],
  controllers: [DiscoveryController],
  providers: [DiscoveryService],
})
export class DiscoveryModule {}
