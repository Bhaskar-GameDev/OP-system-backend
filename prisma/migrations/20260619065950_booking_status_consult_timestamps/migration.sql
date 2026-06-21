/*
  Warnings:

  - You are about to drop the column `consult_end_at` on the `booking_history` table. All the data in the column will be lost.
  - You are about to drop the column `consult_start_at` on the `booking_history` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "booking_history" DROP COLUMN "consult_end_at",
DROP COLUMN "consult_start_at",
ADD COLUMN     "consultation_ended_at" TIMESTAMP(3),
ADD COLUMN     "consultation_started_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "consultation_ended_at" TIMESTAMP(3),
ADD COLUMN     "consultation_started_at" TIMESTAMP(3);
