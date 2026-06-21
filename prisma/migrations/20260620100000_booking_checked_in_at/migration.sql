-- Patient physical check-in (Arrived/Not Arrived). Nullable timestamp, captured
-- like consultation_started_at/ended_at. Purely informational — never drives
-- the Redis queue.
ALTER TABLE "bookings" ADD COLUMN "checked_in_at" TIMESTAMP(3);
