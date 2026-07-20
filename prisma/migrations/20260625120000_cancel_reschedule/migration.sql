-- Patient-initiated cancellation & rescheduling.

-- Per-clinic cutoff: no cancel/reschedule within N minutes of session start.
ALTER TABLE "clinics" ADD COLUMN "cancellation_cutoff_minutes" INTEGER NOT NULL DEFAULT 30;

-- Cancellation reason (optional free text) + refund state stored on the booking.
ALTER TABLE "bookings" ADD COLUMN "cancellation_reason" TEXT;
ALTER TABLE "bookings" ADD COLUMN "refund_status" TEXT;
-- Reschedule link: a new booking points back at the old (cancelled) one.
ALTER TABLE "bookings" ADD COLUMN "reschedule_of_booking_id" TEXT;
