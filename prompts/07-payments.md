Implement a `payments` module integrating PhonePe Payment Gateway with split settlement. Wrap PhonePe
behind a PaymentGateway interface (FakeGateway for tests/local).

POST /payments/init { bookingId }:
- Load booking (must be 'pending', owned by caller). Compute split: platform_fee_inr (config: % +
  floor) to Maidan's merchant, host_payout_inr to the host's payout_ref. Create a payments row
  status 'initiated' with a generated phonepe_order_id and an idempotency key = bookingId.
- Call gateway.createOrder with the split instruction; return the redirect/intent payload to client.
- Never re-init a booking that already has a successful payment (idempotent).

POST /payments/webhook (PhonePe callback, public but signature-verified):
- Verify signature/checksum. Look up by phonepe_order_id. Idempotently apply terminal status.
  On success: payments->'success', booking->'confirmed', store raw_callback, emit 'payment.succeeded'
  AND 'booking.confirmed' in one tx. On failure: 'payment.failed' + emit 'payment.failed'.
- Reject duplicate/late callbacks gracefully (already-terminal = 200 no-op).

Also: on 'booking.cancelled' for a confirmed/paid booking, trigger a refund via gateway and set
payments->'refunded' (can be a small consumer or a method invoked by the bookings flow — keep money
state here).

Config: PLATFORM_FEE_PCT, PLATFORM_FEE_FLOOR_INR. Validate splits sum to amount_inr.

DoD: e2e simulates init→webhook(success)→booking confirmed; replaying the same webhook is a no-op;
splits always reconcile to the total; signature failure is rejected.