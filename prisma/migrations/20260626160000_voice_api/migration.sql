-- Voice (phone) booking API support: pay-at-desk hybrid + DID->clinic routing +
-- call logs. Additive and reversible (down notes at the bottom).

-- 1. Booking: pay-at-desk flag + voice idempotency key
ALTER TABLE "bookings" ADD COLUMN "pay_at_desk" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "bookings" ADD COLUMN "voice_call_sid" TEXT;
CREATE UNIQUE INDEX "bookings_voice_call_sid_key" ON "bookings"("voice_call_sid");

-- 2. DID -> clinic mapping
CREATE TABLE "voice_numbers" (
    "id" TEXT NOT NULL,
    "did_number" TEXT NOT NULL,
    "clinic_id" TEXT NOT NULL,
    "language" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "voice_numbers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "voice_numbers_did_number_key" ON "voice_numbers"("did_number");
CREATE INDEX "voice_numbers_clinic_id_idx" ON "voice_numbers"("clinic_id");
ALTER TABLE "voice_numbers" ADD CONSTRAINT "voice_numbers_clinic_id_fkey"
    FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. Call logs (append-only)
CREATE TABLE "voice_call_logs" (
    "id" TEXT NOT NULL,
    "call_sid" TEXT NOT NULL,
    "did_number" TEXT,
    "caller_phone" TEXT,
    "clinic_id" TEXT,
    "language" TEXT,
    "transcript" JSONB,
    "slots" JSONB,
    "booking_id" TEXT,
    "outcome" TEXT,
    "duration_seconds" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "voice_call_logs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "voice_call_logs_call_sid_key" ON "voice_call_logs"("call_sid");

-- Down (manual):
--   DROP TABLE "voice_call_logs";
--   ALTER TABLE "voice_numbers" DROP CONSTRAINT "voice_numbers_clinic_id_fkey";
--   DROP TABLE "voice_numbers";
--   DROP INDEX "bookings_voice_call_sid_key";
--   ALTER TABLE "bookings" DROP COLUMN "voice_call_sid";
--   ALTER TABLE "bookings" DROP COLUMN "pay_at_desk";
