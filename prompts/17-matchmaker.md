Add a matchmaking worker. On 'booking.confirmed' (and nightly), compute compatibility between an
explorer and co-attendees / the host using: shared interests (array overlap), embedding proximity of
their booked activities, and pillar affinity. Write match_scores(profile_id, activity_id, score,
reason). Expose read-only GET /activities/:id/vibe (via apps/api proxy) summarising the group's
shared interests for the activity's chat/landing — a gentle "who you'll meet" signal, no PII beyond
display names. Keep scoring explainable (store `reason`).
DoD: seeded co-bookings yield non-trivial match_scores; the vibe summary lists real shared interest
tags and never leaks phone numbers.