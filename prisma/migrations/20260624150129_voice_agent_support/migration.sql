/*
  Warnings:

  - A unique constraint covering the columns `[voice_did]` on the table `clinics` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "clinics" ADD COLUMN     "voice_did" TEXT;

-- AlterTable
ALTER TABLE "doctors" ADD COLUMN     "specialty_aliases" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "call_logs" (
    "id" TEXT NOT NULL,
    "call_sid" TEXT NOT NULL,
    "clinic_id" TEXT,
    "caller_phone" TEXT NOT NULL,
    "did_number" TEXT NOT NULL,
    "language" TEXT,
    "transcript" JSONB,
    "slots" JSONB,
    "booking_id" TEXT,
    "outcome" TEXT,
    "duration" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "call_logs_call_sid_key" ON "call_logs"("call_sid");

-- CreateIndex
CREATE INDEX "call_logs_clinic_id_created_at_idx" ON "call_logs"("clinic_id", "created_at");

-- CreateIndex
CREATE INDEX "call_logs_caller_phone_idx" ON "call_logs"("caller_phone");

-- CreateIndex
CREATE UNIQUE INDEX "clinics_voice_did_key" ON "clinics"("voice_did");

-- AddForeignKey
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE SET NULL ON UPDATE CASCADE;
