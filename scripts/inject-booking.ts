/**
 * DEV ONLY — inject a BOOKED booking + queue token for a patient, bypassing
 * Razorpay (which is unconfigured in dev). Mirrors PaymentsService.confirm's
 * token-issuance block exactly, so the Redis queue is real and the patient
 * Socket.io join returns a live snapshot.
 *
 * Usage: npx ts-node scripts/inject-booking.ts <patientId> [doctorId] [sessionDate] [MORNING|EVENING]
 */
import { NestFactory } from '@nestjs/core';
import { BookingSource, BookingStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ConsultationService } from '../src/queue-engine/consultation.service';
import { TokenSource, SessionKey } from '../src/queue-engine/token.service';

async function main() {
  const patientId = process.argv[2];
  const doctorId = process.argv[3] ?? '00000000-0000-0000-0000-000000000003';
  const sessionDate = process.argv[4] ?? new Date().toISOString().slice(0, 10);
  const sessionType = (process.argv[5] ?? 'MORNING') as 'MORNING' | 'EVENING';
  if (!patientId) throw new Error('patientId required');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const prisma = app.get(PrismaService);
  const consult = app.get(ConsultationService);

  const booking = await prisma.booking.create({
    data: {
      patientId,
      doctorId,
      source: BookingSource.APP,
      sessionDate: new Date(sessionDate),
      sessionType,
      status: BookingStatus.BOOKED, // must be BOOKED before enqueue (promote guard)
    },
  });

  const session: SessionKey = { doctorId, sessionDate, sessionType };
  const entry = await consult.enqueueBooking(TokenSource.APP, session, booking.id);
  await prisma.booking.update({
    where: { id: booking.id },
    data: { tokenNumber: entry.tokenNumber },
  });

  console.log(JSON.stringify({
    bookingId: booking.id,
    doctorId,
    sessionDate,
    sessionType,
    tokenNumber: entry.tokenNumber,
  }, null, 2));

  await app.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
