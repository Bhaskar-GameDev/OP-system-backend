-- Desk settlement audit on the legacy payment row: HOW the money was taken,
-- WHO took it, and WHEN. Nullable, so every existing row (online payments and
-- already-settled desk payments alike) stays valid without a backfill.
ALTER TABLE "payments" ADD COLUMN "desk_mode" "OpPaymentMode";
ALTER TABLE "payments" ADD COLUMN "collected_by_id" TEXT;
ALTER TABLE "payments" ADD COLUMN "collected_at" TIMESTAMP(3);
