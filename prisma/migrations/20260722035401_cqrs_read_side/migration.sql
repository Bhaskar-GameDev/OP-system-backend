-- CreateTable
CREATE TABLE "queue_read_model" (
    "encounter_id" TEXT NOT NULL,
    "clinic_id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "op_session_id" TEXT,
    "patient_name" TEXT NOT NULL,
    "token_number" TEXT,
    "category" TEXT,
    "status" "EncounterStatus" NOT NULL,
    "order_key" DOUBLE PRECISION,
    "is_override" BOOLEAN NOT NULL DEFAULT false,
    "is_emergency" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "queue_read_model_pkey" PRIMARY KEY ("encounter_id")
);

-- CreateTable
CREATE TABLE "projection_cursors" (
    "name" TEXT NOT NULL,
    "global_seq" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projection_cursors_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE INDEX "queue_read_model_op_session_id_status_idx" ON "queue_read_model"("op_session_id", "status");

-- CreateIndex
CREATE INDEX "queue_read_model_doctor_id_status_idx" ON "queue_read_model"("doctor_id", "status");

-- CreateIndex
CREATE INDEX "queue_read_model_clinic_id_idx" ON "queue_read_model"("clinic_id");
