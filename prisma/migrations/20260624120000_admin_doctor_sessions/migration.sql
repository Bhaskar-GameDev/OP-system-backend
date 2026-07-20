-- Doctor profile photo (optional URL).
ALTER TABLE "doctors" ADD COLUMN "photo_url" TEXT;

-- Recurring weekly session schedule (template), distinct from queue_sessions.
CREATE TABLE "doctor_sessions" (
    "id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "session_type" "SessionType" NOT NULL,
    "start_time" TEXT NOT NULL,
    "max_tokens" INTEGER NOT NULL,
    "days_of_week" INTEGER[] NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "doctor_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "doctor_sessions_doctor_id_idx" ON "doctor_sessions"("doctor_id");

ALTER TABLE "doctor_sessions"
    ADD CONSTRAINT "doctor_sessions_doctor_id_fkey"
    FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
