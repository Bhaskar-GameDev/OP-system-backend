/**
 * DEMO ONLY — build a live waiting-room board for a clinic.
 *
 * `prisma db seed` deliberately leaves Redis untouched: it re-runs on every
 * container start, and injecting fake patients into a queue that a real demo is
 * mid-way through would corrupt it. So the live ordering the TV board reads is
 * built here instead, opt-in, and only when you actually want a populated
 * screen.
 *
 * Produces deliberately UNEVEN queues — a busy doctor, a light one, and an idle
 * one — because a board where every card looks identical demonstrates nothing.
 * Some tokens are completed so the "Recently seen" strip is populated too.
 *
 * Usage:
 *   npx ts-node scripts/seed-display-queue.ts [clinicId]
 *
 * Re-running clears the day's queues for that clinic first, so the board ends
 * up in the same state rather than stacking tokens on every invocation.
 */
import { NestFactory } from '@nestjs/core';
import { BookingSource, BookingStatus, SessionType } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ConsultationService } from '../src/queue-engine/consultation.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { SessionResolverService } from '../src/bookings/session-resolver.service';
import { SessionKey, TokenSource } from '../src/queue-engine/token.service';

/** City Care Clinic — the clinic the rest of the demo material uses. */
const DEFAULT_CLINIC = '00000000-0000-0000-0000-000000000001';

/**
 * Queue shape per doctor, applied in board order: how many patients to enqueue
 * and how many of those to then complete. The doctor being consulted is the
 * first token still in the queue, so `queued - completed` is what stays visible.
 */
const SHAPES = [
  { queued: 7, completed: 3 }, // busy — long queue, several already seen
  { queued: 3, completed: 1 }, // light — short queue
  { queued: 0, completed: 0 }, // idle — card still shown, open for walk-ins
];

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function main(): Promise<void> {
  const clinicId = process.argv[2] ?? DEFAULT_CLINIC;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  const prisma = app.get(PrismaService);
  const consult = app.get(ConsultationService);
  const queue = app.get(QueueService);
  const resolver = app.get(SessionResolverService);

  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { id: true, name: true },
  });
  if (!clinic) throw new Error(`clinic ${clinicId} not found — run 'npm run db:seed' first`);

  const doctors = await prisma.doctor.findMany({
    where: { clinicId },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  const patients = await prisma.patient.findMany({
    select: { id: true },
    orderBy: { mobile: 'asc' },
  });
  if (patients.length === 0) throw new Error("no patients — run 'npm run db:seed' first");

  const date = ymdLocal(new Date());
  let shapeIndex = 0;
  const summary: Record<string, string> = {};

  for (const doctor of doctors) {
    // Only doctors actually consulting today belong on the board; the display
    // uses the same resolver, so matching it here keeps the two consistent.
    const today = await resolver.resolveToday(doctor.id);
    if (today.status !== 'OPEN') {
      summary[doctor.name] = 'not consulting today — off the board';
      continue;
    }

    const session: SessionKey = {
      doctorId: doctor.id,
      sessionDate: date,
      sessionType: today.session.sessionType,
    };
    const shape = SHAPES[shapeIndex % SHAPES.length];
    shapeIndex++;

    // Reset so re-running is idempotent rather than cumulative.
    await queue.clearSession(session);
    await prisma.booking.deleteMany({
      where: {
        doctorId: doctor.id,
        sessionDate: new Date(`${date}T00:00:00.000Z`),
        sessionType: session.sessionType as SessionType,
      },
    });

    const issued: string[] = [];
    for (let i = 0; i < shape.queued; i++) {
      const patient = patients[i % patients.length];
      const booking = await prisma.booking.create({
        data: {
          patientId: patient.id,
          doctorId: doctor.id,
          source: i % 3 === 0 ? BookingSource.WALK_IN : BookingSource.APP,
          sessionDate: new Date(`${date}T00:00:00.000Z`),
          sessionType: session.sessionType as SessionType,
          status: BookingStatus.BOOKED, // enqueue's promote guard requires this
        },
        select: { id: true },
      });
      const entry = await consult.enqueueBooking(
        i % 3 === 0 ? TokenSource.WALK_IN : TokenSource.APP,
        session,
        booking.id,
      );
      await prisma.booking.update({
        where: { id: booking.id },
        data: { tokenNumber: entry.tokenNumber },
      });
      issued.push(entry.tokenNumber);
    }

    // Complete from the front, which is what fills "Recently seen".
    for (let i = 0; i < shape.completed; i++) {
      await consult.markDone(session);
    }

    const remaining = await queue.list(session);
    summary[doctor.name] =
      remaining.length > 0
        ? `${session.sessionType}: serving ${remaining[0]}, ${remaining.length - 1} waiting, ${shape.completed} seen`
        : `${session.sessionType}: idle`;
  }

  const port = process.env.PORT ?? '3000';
  console.log(`\nBoard ready for ${clinic.name}`);
  for (const [name, line] of Object.entries(summary)) {
    console.log(`  ${name.padEnd(22)} ${line}`);
  }
  console.log(`\n  http://localhost:${port}/display/${clinicId}\n`);

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
