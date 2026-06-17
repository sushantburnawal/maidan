Implement a `bookings` module. Booking is correctness-critical — no overbooking, ever.

POST /bookings { slotId, headcount } (explorer):
- In a single DB transaction: SELECT the slot FOR UPDATE; reject if status != 'open' or
  booked_count + headcount > capacity; insert booking status 'pending'; increment booked_count;
  flip slot to 'full' when capacity reached. Compute amount_inr from activity price * headcount
  server-side (ignore any client amount). Write a 'booking.created' outbox event in the same tx.
- Return the booking + a flag indicating payment is required next.

POST /bookings/:id/cancel (owner of booking):
- Within tx: only if status in ('pending','confirmed') and slot.starts_at in the future; set
  'cancelled', decrement booked_count, reopen slot if it was full; emit 'booking.cancelled'.
  Add the "responsible cancellation" Maidan Way note in the response copy (advisory).
- Refund handling is delegated to the payments module via the event, not done here.

GET /bookings/me — explorer's bookings; GET /activities/:id/bookings — host view (owner only).

DoD: a concurrency test fires N simultaneous bookings against a capacity-1 slot and asserts exactly
one succeeds (use Promise.all hitting a test slot). Cancellation reopens capacity.