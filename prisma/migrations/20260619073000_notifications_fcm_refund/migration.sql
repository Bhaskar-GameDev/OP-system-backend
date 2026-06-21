-- Step 6 — Notifications: patient FCM device token + payment refund reference.
ALTER TABLE "patients" ADD COLUMN "fcm_token" TEXT;
ALTER TABLE "payments" ADD COLUMN "razorpay_refund_id" TEXT;
