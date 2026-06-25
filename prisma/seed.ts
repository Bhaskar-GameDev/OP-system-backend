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

  // ── Extra clinics + doctors for patient app discovery ──────────────────────
  const APOLLO_ID  = '00000000-0000-0000-0000-000000000010';
  const FORTIS_ID  = '00000000-0000-0000-0000-000000000011';

  await prisma.clinic.upsert({
    where: { id: APOLLO_ID },
    update: {},
    create: { id: APOLLO_ID, name: 'Apollo Hospitals', address: '21 Greams Lane, Chennai', contactNumber: '+91-44-28293333' },
  });

  await prisma.clinic.upsert({
    where: { id: FORTIS_ID },
    update: {},
    create: { id: FORTIS_ID, name: 'Fortis Healthcare', address: '14 Cunningham Road, Bangalore', contactNumber: '+91-80-66214444' },
  });

  const drPriya = await bcrypt.hash('doctor123', 12);
  await prisma.doctor.upsert({
    where: { id: '00000000-0000-0000-0000-000000000020' },
    update: {},
    create: { id: '00000000-0000-0000-0000-000000000020', clinicId: APOLLO_ID, name: 'Dr. Priya Ramesh', specialization: 'Cardiology', consultationFee: 800, avgConsultMinutes: 10, username: 'priya.ramesh', passwordHash: drPriya },
  });

  const drArun = await bcrypt.hash('doctor123', 12);
  await prisma.doctor.upsert({
    where: { id: '00000000-0000-0000-0000-000000000021' },
    update: {},
    create: { id: '00000000-0000-0000-0000-000000000021', clinicId: FORTIS_ID, name: 'Dr. Sunita Verma', specialization: 'Dermatology', consultationFee: 600, avgConsultMinutes: 8, username: 'sunita.verma', passwordHash: drArun },
  });

  // ── Voice agent demo: City Care Hospital, Kadapa + multilingual doctors ─────
  // The standalone voice agent resolves this clinic either by the dialed DID
  // (voiceDid) or via VOICE_DEFAULT_CLINIC_ID. specialtyAliases carry the
  // English/Telugu/Hindi colloquial terms the agent matches against.
  const CITY_CARE_ID = '00000000-0000-0000-0000-000000000100';

  await prisma.clinic.upsert({
    where: { id: CITY_CARE_ID },
    update: { voiceDid: '+918000000000' },
    create: {
      id: CITY_CARE_ID,
      name: 'City Care Hospital',
      address: 'Kadapa, Andhra Pradesh',
      contactNumber: '+918000000000',
      voiceDid: '+918000000000', // the Vobiz DID patients call
    },
  });

  const voiceDoctors: Array<{
    id: string;
    name: string;
    specialization: string;
    avgConsultMinutes: number;
    aliases: string[];
  }> = [
    {
      id: '00000000-0000-0000-0000-000000000101',
      name: 'Dr. Kumar',
      specialization: 'Dermatology',
      avgConsultMinutes: 15,
      aliases: ['skin doctor', 'skin specialist', 'చర్మ వైద్యుడు', 'त्वचा विशेषज्ञ'],
    },
    {
      id: '00000000-0000-0000-0000-000000000102',
      name: 'Dr. Lakshmi',
      specialization: 'General Medicine',
      avgConsultMinutes: 10,
      aliases: ['general doctor', 'physician', 'సాధారణ వైద్యుడు', 'जनरल डॉक्टर'],
    },
    {
      id: '00000000-0000-0000-0000-000000000103',
      name: 'Dr. Rajesh',
      specialization: 'Cardiology',
      avgConsultMinutes: 20,
      aliases: ['heart doctor', 'హృదయ వైద్యుడు', 'दिल का डॉक्टर'],
    },
    {
      id: '00000000-0000-0000-0000-000000000104',
      name: 'Dr. Priya',
      specialization: 'Gynecology',
      avgConsultMinutes: 15,
      aliases: ['lady doctor', 'gynecologist', 'స్త్రీ వైద్యుడు', 'महिला डॉक्टर'],
    },
    {
      id: '00000000-0000-0000-0000-000000000105',
      name: 'Dr. Suresh',
      specialization: 'Pediatrics',
      avgConsultMinutes: 15,
      aliases: ['children doctor', 'child specialist', 'పిల్లల డాక్టర్', 'बच्चों का डॉक्टर'],
    },
    {
      id: '00000000-0000-0000-0000-000000000106',
      name: 'Dr. Anand',
      specialization: 'Orthopedics',
      avgConsultMinutes: 20,
      aliases: ['bone doctor', 'ఎముకల డాక్టర్', 'हड्डी का डॉक्टर'],
    },
    {
      id: '00000000-0000-0000-0000-000000000107',
      name: 'Dr. Meena',
      specialization: 'Ophthalmology',
      avgConsultMinutes: 15,
      aliases: ['eye doctor', 'కంటి డాక్టర్', 'आंखों का डॉक्टर'],
    },
    {
      id: '00000000-0000-0000-0000-000000000108',
      name: 'Dr. Venkat',
      specialization: 'Dentistry',
      avgConsultMinutes: 20,
      aliases: ['teeth doctor', 'dentist', 'పంటి డాక్టర్', 'दांतों का डॉक्टर'],
    },
  ];

  for (const d of voiceDoctors) {
    await prisma.doctor.upsert({
      where: { id: d.id },
      update: { specialtyAliases: d.aliases, specialization: d.specialization },
      create: {
        id: d.id,
        clinicId: CITY_CARE_ID,
        name: d.name,
        specialization: d.specialization,
        specialtyAliases: d.aliases,
        consultationFee: 400,
        avgConsultMinutes: d.avgConsultMinutes,
      },
    });
  }

  console.log('Seed complete:');
  console.log('  clinicId =', CLINIC_ID);
  console.log('  voice demo: City Care Hospital =', CITY_CARE_ID, '(DID +918000000000)');
  console.log('  -> set VOICE_DEFAULT_CLINIC_ID =', CITY_CARE_ID);
  console.log('  doctorId =', DOCTOR_ID);
  console.log('  receptionist  reception / reception123');
  console.log('  doctor        drsmith / doctor123');
  console.log('  + Apollo Hospitals, Fortis Healthcare, Dr. Priya Ramesh, Dr. Sunita Verma');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
