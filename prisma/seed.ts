/**
 * Dev seed for the Reception Dashboard.
 *
 * Creates a deterministic clinic + receptionist (STAFF) + one doctor so the
 * desktop app can log in and exercise the live queue against real data.
 *
 * Credentials (DEV ONLY):
 *   receptionist  username: reception   password: reception123
 *   doctor        username: drsmith     password: doctor123
 *
 * Idempotent: re-running upserts the same rows by stable ids.
 */
import { PrismaClient, StaffRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const CLINIC_ID = '00000000-0000-0000-0000-000000000001';
const STAFF_ID = '00000000-0000-0000-0000-000000000002';
const DOCTOR_ID = '00000000-0000-0000-0000-000000000003';

async function main(): Promise<void> {
  await prisma.clinic.upsert({
    where: { id: CLINIC_ID },
    update: {},
    create: {
      id: CLINIC_ID,
      name: 'Demo Clinic',
      address: '1 Reception Way',
      contactNumber: '+910000000000',
    },
  });

  const staffHash = await bcrypt.hash('reception123', 12);
  await prisma.staff.upsert({
    where: { id: STAFF_ID },
    update: { loginCredentials: staffHash, username: 'reception' },
    create: {
      id: STAFF_ID,
      clinicId: CLINIC_ID,
      name: 'Front Desk',
      role: StaffRole.RECEPTIONIST,
      username: 'reception',
      loginCredentials: staffHash,
    },
  });

  const doctorHash = await bcrypt.hash('doctor123', 12);
  await prisma.doctor.upsert({
    where: { id: DOCTOR_ID },
    update: { passwordHash: doctorHash, username: 'drsmith' },
    create: {
      id: DOCTOR_ID,
      clinicId: CLINIC_ID,
      name: 'Dr. Smith',
      specialization: 'General Medicine',
      consultationFee: 500,
      avgConsultMinutes: 10,
      username: 'drsmith',
      passwordHash: doctorHash,
    },
  });

  console.log('Seed complete:');
  console.log('  clinicId =', CLINIC_ID);
  console.log('  doctorId =', DOCTOR_ID);
  console.log('  receptionist  reception / reception123');
  console.log('  doctor        drsmith / doctor123');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
