-- Append-only audit of staff/doctor queue-control actions. WHO did WHAT to which
-- token, in which session. Written after the action succeeds; never updated.

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "actor_role" TEXT NOT NULL,
    "clinic_id" TEXT,
    "action" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "session_date" DATE NOT NULL,
    "session_type" "SessionType" NOT NULL,
    "token" TEXT,
    "booking_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_clinic_id_created_at_idx" ON "audit_logs"("clinic_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_doctor_id_session_date_idx" ON "audit_logs"("doctor_id", "session_date");
