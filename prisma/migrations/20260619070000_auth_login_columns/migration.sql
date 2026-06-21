-- Auth login columns: username/password for staff + doctors.
ALTER TABLE "doctors" ADD COLUMN "username" TEXT;
ALTER TABLE "doctors" ADD COLUMN "password_hash" TEXT;
ALTER TABLE "staff" ADD COLUMN "username" TEXT;

CREATE UNIQUE INDEX "doctors_username_key" ON "doctors"("username");
CREATE UNIQUE INDEX "staff_username_key" ON "staff"("username");
