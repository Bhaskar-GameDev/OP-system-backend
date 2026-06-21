import { Module } from '@nestjs/common';
import { ArchivalService } from './archival.service';

// Step 7 — Historical archival. Decoupled @Cron sweep; no controller surface.
@Module({
  providers: [ArchivalService],
  exports: [ArchivalService],
})
export class ArchivalModule {}
