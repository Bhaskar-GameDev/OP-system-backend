-- Razorpay order/payment ids on payments (dedup keys for idempotent confirm).
ALTER TABLE "payments" ADD COLUMN "razorpay_order_id" TEXT;
ALTER TABLE "payments" ADD COLUMN "razorpay_payment_id" TEXT;

CREATE UNIQUE INDEX "payments_razorpay_order_id_key" ON "payments"("razorpay_order_id");
CREATE UNIQUE INDEX "payments_razorpay_payment_id_key" ON "payments"("razorpay_payment_id");
