-- CreateTable
CREATE TABLE "consultation_notes" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "diagnosis" TEXT,
    "prescriptions" TEXT,
    "follow_up_date" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consultation_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "consultation_notes_booking_id_key" ON "consultation_notes"("booking_id");

-- CreateIndex
CREATE INDEX "consultation_notes_doctor_id_idx" ON "consultation_notes"("doctor_id");

-- AddForeignKey
ALTER TABLE "consultation_notes" ADD CONSTRAINT "consultation_notes_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
