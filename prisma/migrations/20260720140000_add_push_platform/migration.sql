-- Platform-aware push tokens.
--
-- Purely additive: the column is nullable with no backfill. Existing rows keep
-- NULL, which the application reads as ANDROID — safe because iOS push never
-- worked before this change, so no stored token can be an iOS one.

-- CreateEnum
CREATE TYPE "PushPlatform" AS ENUM ('ANDROID', 'IOS');

-- AlterTable
ALTER TABLE "patients" ADD COLUMN     "push_platform" "PushPlatform";
