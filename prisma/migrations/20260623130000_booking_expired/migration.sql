-- Add EXPIRED terminal state for bookings whose payment failed or was never
-- completed (Razorpay payment.failed webhook, or the pending-payment timeout
-- sweep). These bookings never received a queue token.
ALTER TYPE "BookingStatus" ADD VALUE 'EXPIRED';
