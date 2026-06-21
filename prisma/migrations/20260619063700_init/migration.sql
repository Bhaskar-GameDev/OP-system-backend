-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER');

-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('RECEPTIONIST', 'DOCTOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "SessionType" AS ENUM ('MORNING', 'EVENING');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PENDING_PAYMENT', 'BOOKED', 'ACTIVE', 'COMPLETED', 'NO_SHOW', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'SUCCESS', 'FAILED', 'REFUNDED');

-- CreateTable
CREATE TABLE "patients" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    "age" INTEGER,
    "gender" "Gender",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinics" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "contact_number" TEXT,

    CONSTRAINT "clinics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctors" (
    "id" TEXT NOT NULL,
    "clinic_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "specialization" TEXT,
    "consultation_fee" INTEGER NOT NULL DEFAULT 0,
    "avg_consult_minutes" INTEGER NOT NULL DEFAULT 10,

    CONSTRAINT "doctors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff" (
    "id" TEXT NOT NULL,
    "clinic_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL,
    "login_credentials" TEXT NOT NULL,

    CONSTRAINT "staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "token_number" TEXT,
    "session_date" DATE NOT NULL,
    "session_type" "SessionType" NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "payment_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "gateway_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queue_sessions" (
    "id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "session_date" DATE NOT NULL,
    "session_type" "SessionType" NOT NULL,
    "active_booking_id" TEXT,
    "is_open" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "queue_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_history" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "clinic_id" TEXT NOT NULL,
    "token_number" TEXT,
    "session_date" DATE NOT NULL,
    "session_type" "SessionType" NOT NULL,
    "final_status" "BookingStatus" NOT NULL,
    "payment_amount" INTEGER,
    "payment_status" "PaymentStatus",
    "payment_ref" TEXT,
    "booked_at" TIMESTAMP(3) NOT NULL,
    "consult_start_at" TIMESTAMP(3),
    "consult_end_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_daily" (
    "id" TEXT NOT NULL,
    "clinic_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "patients_seen" INTEGER NOT NULL DEFAULT 0,
    "avg_wait_time" INTEGER NOT NULL DEFAULT 0,
    "avg_consult_time" INTEGER NOT NULL DEFAULT 0,
    "no_shows" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "analytics_daily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "patients_mobile_key" ON "patients"("mobile");

-- CreateIndex
CREATE INDEX "patients_mobile_idx" ON "patients"("mobile");

-- CreateIndex
CREATE INDEX "doctors_clinic_id_idx" ON "doctors"("clinic_id");

-- CreateIndex
CREATE INDEX "staff_clinic_id_idx" ON "staff"("clinic_id");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_payment_id_key" ON "bookings"("payment_id");

-- CreateIndex
CREATE INDEX "bookings_doctor_id_session_date_session_type_idx" ON "bookings"("doctor_id", "session_date", "session_type");

-- CreateIndex
CREATE INDEX "bookings_patient_id_idx" ON "bookings"("patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_doctor_id_session_date_session_type_token_number_key" ON "bookings"("doctor_id", "session_date", "session_type", "token_number");

-- CreateIndex
CREATE INDEX "payments_booking_id_idx" ON "payments"("booking_id");

-- CreateIndex
CREATE INDEX "queue_sessions_doctor_id_idx" ON "queue_sessions"("doctor_id");

-- CreateIndex
CREATE UNIQUE INDEX "queue_sessions_doctor_id_session_date_session_type_key" ON "queue_sessions"("doctor_id", "session_date", "session_type");

-- CreateIndex
CREATE UNIQUE INDEX "booking_history_booking_id_key" ON "booking_history"("booking_id");

-- CreateIndex
CREATE INDEX "booking_history_clinic_id_session_date_idx" ON "booking_history"("clinic_id", "session_date");

-- CreateIndex
CREATE INDEX "booking_history_patient_id_idx" ON "booking_history"("patient_id");

-- CreateIndex
CREATE INDEX "analytics_daily_clinic_id_idx" ON "analytics_daily"("clinic_id");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_daily_clinic_id_date_key" ON "analytics_daily"("clinic_id", "date");

-- AddForeignKey
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_sessions" ADD CONSTRAINT "queue_sessions_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
