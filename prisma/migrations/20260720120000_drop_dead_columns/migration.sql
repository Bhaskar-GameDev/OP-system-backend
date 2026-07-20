-- Cleanup: drop two columns left behind by removed features.
--
--   bookings.reschedule_of_booking_id — reschedule was removed with the move to
--     same-day booking. No writers, no readers, no UI.
--   clinics.cancellation_cutoff_minutes — the time-based cancellation cutoff was
--     removed; cancel eligibility is the booking-status gate alone. No prod code
--     read it (only a test seeded a value).
--
-- Both are additive-to-remove and carry no data anything depends on.

ALTER TABLE "bookings" DROP COLUMN "reschedule_of_booking_id";
ALTER TABLE "clinics" DROP COLUMN "cancellation_cutoff_minutes";

-- Down (manual reversal) — re-adds both as nullable/defaulted, never crashes:
--   ALTER TABLE "bookings" ADD COLUMN "reschedule_of_booking_id" TEXT;
--   ALTER TABLE "clinics" ADD COLUMN "cancellation_cutoff_minutes" INTEGER NOT NULL DEFAULT 30;
-- (Historical values are not recoverable — neither column was read by any code.)
