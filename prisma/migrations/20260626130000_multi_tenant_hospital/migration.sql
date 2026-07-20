-- Multi-tenant isolation: introduce Hospital as the top-level tenant owning
-- Clinics and Staff. Existing rows are backfilled into one demo hospital so the
-- NOT NULL FKs can be added without data loss. Reversible (see down note below).

-- 1. Hospital table
CREATE TABLE "hospitals" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "hospitals_pkey" PRIMARY KEY ("id")
);

-- 2. Add hospital_id columns (nullable first so existing rows survive)
ALTER TABLE "clinics" ADD COLUMN "hospital_id" TEXT;
ALTER TABLE "staff" ADD COLUMN "hospital_id" TEXT;

-- 3. Backfill: a single demo hospital owns every pre-existing clinic + staff.
--    (The demo seed later reassigns some clinics/staff to a second hospital.)
INSERT INTO "hospitals" ("id", "name")
VALUES ('00000000-0000-0000-0000-0000000000a1', 'Demo Health Group');

UPDATE "clinics" SET "hospital_id" = '00000000-0000-0000-0000-0000000000a1'
WHERE "hospital_id" IS NULL;

-- Staff inherit their clinic's hospital during backfill.
UPDATE "staff" s SET "hospital_id" = c."hospital_id"
FROM "clinics" c WHERE s."clinic_id" = c."id" AND s."hospital_id" IS NULL;

-- 4. Enforce NOT NULL now that every row is populated, and set the backfill
--    hospital as the column DEFAULT so an insert that omits hospital_id lands in
--    the demo tenant rather than violating NOT NULL (real creates pass it).
ALTER TABLE "clinics" ALTER COLUMN "hospital_id" SET NOT NULL;
ALTER TABLE "clinics" ALTER COLUMN "hospital_id" SET DEFAULT '00000000-0000-0000-0000-0000000000a1';
ALTER TABLE "staff" ALTER COLUMN "hospital_id" SET NOT NULL;
ALTER TABLE "staff" ALTER COLUMN "hospital_id" SET DEFAULT '00000000-0000-0000-0000-0000000000a1';

-- 5. Indexes + FKs
CREATE INDEX "clinics_hospital_id_idx" ON "clinics"("hospital_id");
CREATE INDEX "staff_hospital_id_idx" ON "staff"("hospital_id");

ALTER TABLE "clinics" ADD CONSTRAINT "clinics_hospital_id_fkey"
    FOREIGN KEY ("hospital_id") REFERENCES "hospitals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "staff" ADD CONSTRAINT "staff_hospital_id_fkey"
    FOREIGN KEY ("hospital_id") REFERENCES "hospitals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Down (manual reversal):
--   ALTER TABLE "staff" DROP CONSTRAINT "staff_hospital_id_fkey";
--   ALTER TABLE "clinics" DROP CONSTRAINT "clinics_hospital_id_fkey";
--   DROP INDEX "staff_hospital_id_idx"; DROP INDEX "clinics_hospital_id_idx";
--   ALTER TABLE "staff" DROP COLUMN "hospital_id";
--   ALTER TABLE "clinics" DROP COLUMN "hospital_id";
--   DROP TABLE "hospitals";
