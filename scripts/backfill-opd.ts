/**
 * One-shot legacy backfill (Phase 15): project every `Booking` into the new OPD
 * aggregates. Idempotent — safe to re-run. Usage:
 *
 *   npx ts-node scripts/backfill-opd.ts
 *
 * Then rebuild read models:  ProjectionRunner.rebuild()  (or run the app).
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { BackfillService } from '../src/migration/backfill.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  try {
    const backfill = app.get(BackfillService);
    const result = await backfill.run();
    // eslint-disable-next-line no-console
    console.log(`Backfill complete: ${JSON.stringify(result)}`);
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
