import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { EventStoreService } from './event-store.service';

/**
 * Global so any domain module can emit/read events without re-importing.
 * The event store is the backbone of the token engine (ARCHITECTURE.md §12).
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [EventStoreService],
  exports: [EventStoreService],
})
export class EventStoreModule {}
