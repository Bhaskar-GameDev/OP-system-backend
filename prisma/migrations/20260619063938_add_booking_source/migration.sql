/*
  Warnings:

  - Added the required column `source` to the `booking_history` table without a default value. This is not possible if the table is not empty.
  - Added the required column `source` to the `bookings` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "BookingSource" AS ENUM ('APP', 'WALK_IN', 'VOICE');

-- AlterTable
ALTER TABLE "booking_history" ADD COLUMN     "source" "BookingSource" NOT NULL;

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "source" "BookingSource" NOT NULL;
