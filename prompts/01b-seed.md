Add /db/seed.sql (and a `make seed` target) that inserts a believable Bengaluru dataset:
- ~8 hosts (one named Hemant) with host_profiles.
- ~25 activities spread across move/learn/feel with realistic Bengaluru locations
  (Cubbon Park, Nandi Hills, Indiranagar, Koramangala, JP Nagar) using real-ish lat/lng.
  Include "Nandi Hills sunrise trail ride" hosted by Hemant.
- 2–3 future slots per activity, a handful of bookings + payments in mixed states, a few posts
  (one linking the trail ride), one group_chat with members and messages.
- Leave activities.embedding NULL (the AI service will backfill).
DoD: `make seed` runs idempotently; a map/radius query around Nandi Hills returns the trail ride.