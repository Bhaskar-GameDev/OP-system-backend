-- CreateEnum
CREATE TYPE "RegistrationSource" AS ENUM ('APP', 'VOICE_AGENT', 'RECEPTION');

-- CreateEnum
CREATE TYPE "RegistrationReason" AS ENUM ('NEW', 'FOLLOW_UP', 'REVIEW', 'CORPORATE', 'STAFF', 'REFERRED');

-- CreateEnum
CREATE TYPE "EncounterStatus" AS ENUM ('REGISTERED', 'ARRIVED', 'CHECKED_IN', 'TOKEN_ISSUED', 'WAITING', 'CALLED', 'IN_CONSULTATION', 'PAUSED', 'SKIPPED', 'RECALLED', 'NO_SHOW', 'COMPLETED', 'TRANSFERRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CheckInMethod" AS ENUM ('DESK', 'APP_GEOFENCE', 'KIOSK', 'AUTO');

-- CreateEnum
CREATE TYPE "QueueEntryState" AS ENUM ('WAITING', 'CALLED', 'SKIPPED', 'RECALLED', 'IN_CONSULT', 'REMOVED');

-- CreateEnum
CREATE TYPE "ConsultationState" AS ENUM ('PENDING', 'ACTIVE', 'PAUSED', 'COMPLETED', 'TRANSFERRED');

-- CreateEnum
CREATE TYPE "OpSessionState" AS ENUM ('SCHEDULED', 'OPEN', 'PAUSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TokenResetPolicy" AS ENUM ('PER_SESSION', 'DAILY', 'WEEKLY', 'NEVER');

-- CreateEnum
CREATE TYPE "QueuePolicyMode" AS ENUM ('SHARED_FIFO', 'INDEPENDENT', 'RATIO', 'MANUAL_SWITCH');

-- CreateEnum
CREATE TYPE "OverrideReason" AS ENUM ('VIP', 'MANAGEMENT', 'STAFF', 'RELATIVE', 'KNOWN_PATIENT', 'OTHER');

-- CreateEnum
CREATE TYPE "OpPaymentMode" AS ENUM ('ONLINE', 'CASH', 'UPI_DESK', 'CORPORATE_BILL', 'WAIVED');

-- CreateTable
CREATE TABLE "encounters" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "hospital_id" TEXT NOT NULL,
    "clinic_id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "department_id" TEXT,
    "service_date" DATE NOT NULL,
    "registration_reason" "RegistrationReason" NOT NULL DEFAULT 'NEW',
    "op_category_id" TEXT NOT NULL,
    "status" "EncounterStatus" NOT NULL DEFAULT 'REGISTERED',
    "override" BOOLEAN NOT NULL DEFAULT false,
    "override_reason" "OverrideReason",
    "legacy_booking_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "encounters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registrations" (
    "id" TEXT NOT NULL,
    "encounter_id" TEXT NOT NULL,
    "source" "RegistrationSource" NOT NULL,
    "actor_id" TEXT,
    "channel_meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "check_ins" (
    "id" TEXT NOT NULL,
    "encounter_id" TEXT NOT NULL,
    "method" "CheckInMethod" NOT NULL,
    "checked_in_by" TEXT,
    "checked_in_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "check_ins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tokens" (
    "id" TEXT NOT NULL,
    "encounter_id" TEXT NOT NULL,
    "series_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "display_number" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voided_at" TIMESTAMP(3),

    CONSTRAINT "tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queue_entries" (
    "id" TEXT NOT NULL,
    "encounter_id" TEXT NOT NULL,
    "op_session_id" TEXT NOT NULL,
    "token_id" TEXT NOT NULL,
    "state" "QueueEntryState" NOT NULL DEFAULT 'WAITING',
    "order_key" DOUBLE PRECISION NOT NULL,
    "enqueued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "queue_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consultations" (
    "id" TEXT NOT NULL,
    "encounter_id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "room_id" TEXT,
    "state" "ConsultationState" NOT NULL DEFAULT 'PENDING',
    "started_at" TIMESTAMP(3),
    "paused_at" TIMESTAMP(3),
    "resumed_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "interrupted_by_consultation_id" TEXT,
    "is_emergency" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consultations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "op_sessions" (
    "id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "clinic_id" TEXT NOT NULL,
    "service_date" DATE NOT NULL,
    "session_template_id" TEXT,
    "state" "OpSessionState" NOT NULL DEFAULT 'SCHEDULED',
    "active_consultation_id" TEXT,
    "opened_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "op_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "op_payments" (
    "id" TEXT NOT NULL,
    "encounter_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "mode" "OpPaymentMode" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "gateway_refs" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "op_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_series" (
    "id" TEXT NOT NULL,
    "clinic_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT '',
    "padWidth" INTEGER NOT NULL DEFAULT 3,
    "startAt" INTEGER NOT NULL DEFAULT 1,
    "reset_policy" "TokenResetPolicy" NOT NULL DEFAULT 'PER_SESSION',
    "fee" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "token_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queue_policies" (
    "id" TEXT NOT NULL,
    "clinic_id" TEXT NOT NULL,
    "doctor_id" TEXT,
    "mode" "QueuePolicyMode" NOT NULL DEFAULT 'SHARED_FIFO',
    "ratio" JSONB,
    "categories" JSONB,
    "skip_rules" JSONB,
    "recall_rules" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "queue_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_templates" (
    "id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "clinic_id" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "day_of_week" INTEGER NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT,
    "expected_load" INTEGER NOT NULL DEFAULT 0,
    "room_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_events" (
    "id" TEXT NOT NULL,
    "stream_type" TEXT NOT NULL,
    "stream_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "metadata" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "global_seq" BIGSERIAL NOT NULL,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "encounters_legacy_booking_id_key" ON "encounters"("legacy_booking_id");

-- CreateIndex
CREATE INDEX "encounters_doctor_id_service_date_idx" ON "encounters"("doctor_id", "service_date");

-- CreateIndex
CREATE INDEX "encounters_patient_id_idx" ON "encounters"("patient_id");

-- CreateIndex
CREATE INDEX "encounters_clinic_id_service_date_idx" ON "encounters"("clinic_id", "service_date");

-- CreateIndex
CREATE INDEX "encounters_status_idx" ON "encounters"("status");

-- CreateIndex
CREATE INDEX "registrations_source_created_at_idx" ON "registrations"("source", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "registrations_encounter_id_key" ON "registrations"("encounter_id");

-- CreateIndex
CREATE UNIQUE INDEX "check_ins_encounter_id_key" ON "check_ins"("encounter_id");

-- CreateIndex
CREATE UNIQUE INDEX "tokens_encounter_id_key" ON "tokens"("encounter_id");

-- CreateIndex
CREATE INDEX "tokens_encounter_id_idx" ON "tokens"("encounter_id");

-- CreateIndex
CREATE UNIQUE INDEX "tokens_series_id_sequence_issued_at_key" ON "tokens"("series_id", "sequence", "issued_at");

-- CreateIndex
CREATE UNIQUE INDEX "queue_entries_encounter_id_key" ON "queue_entries"("encounter_id");

-- CreateIndex
CREATE INDEX "queue_entries_op_session_id_state_idx" ON "queue_entries"("op_session_id", "state");

-- CreateIndex
CREATE INDEX "consultations_encounter_id_idx" ON "consultations"("encounter_id");

-- CreateIndex
CREATE INDEX "consultations_doctor_id_state_idx" ON "consultations"("doctor_id", "state");

-- CreateIndex
CREATE INDEX "op_sessions_doctor_id_service_date_idx" ON "op_sessions"("doctor_id", "service_date");

-- CreateIndex
CREATE INDEX "op_payments_encounter_id_idx" ON "op_payments"("encounter_id");

-- CreateIndex
CREATE INDEX "token_series_clinic_id_idx" ON "token_series"("clinic_id");

-- CreateIndex
CREATE UNIQUE INDEX "token_series_clinic_id_code_key" ON "token_series"("clinic_id", "code");

-- CreateIndex
CREATE INDEX "queue_policies_clinic_id_idx" ON "queue_policies"("clinic_id");

-- CreateIndex
CREATE UNIQUE INDEX "queue_policies_clinic_id_doctor_id_key" ON "queue_policies"("clinic_id", "doctor_id");

-- CreateIndex
CREATE INDEX "session_templates_doctor_id_day_of_week_idx" ON "session_templates"("doctor_id", "day_of_week");

-- CreateIndex
CREATE INDEX "domain_events_stream_type_stream_id_idx" ON "domain_events"("stream_type", "stream_id");

-- CreateIndex
CREATE INDEX "domain_events_type_occurred_at_idx" ON "domain_events"("type", "occurred_at");

-- CreateIndex
CREATE INDEX "domain_events_global_seq_idx" ON "domain_events"("global_seq");

-- CreateIndex
CREATE UNIQUE INDEX "domain_events_stream_type_stream_id_version_key" ON "domain_events"("stream_type", "stream_id", "version");
