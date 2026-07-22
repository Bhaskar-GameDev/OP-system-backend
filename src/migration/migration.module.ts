import { Module } from '@nestjs/common';
import { BackfillService } from './backfill.service';

/** Legacy migration (Phase 15). Booking god-row → separated aggregates. */
@Module({
  providers: [BackfillService],
  exports: [BackfillService],
})
export class MigrationModule {}
