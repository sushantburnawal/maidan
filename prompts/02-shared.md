In packages/shared, generate TypeScript types + zod schemas that are the single source of truth for
cross-service contracts. Treat these as frozen once merged.

Include:
- Entity types mirroring the DB tables from Prompt 1 (Profile, Activity, Slot, Booking, Payment, …).
- DTOs: CreateActivityDto, NearbyQueryDto, CreateBookingDto, InitPaymentDto, etc. (zod + inferred TS).
- A DomainEvent discriminated union with these event_type literals and typed payloads:
    'activity.published', 'activity.updated',
    'booking.created', 'booking.confirmed', 'booking.cancelled',
    'payment.succeeded', 'payment.failed',
    'review.created', 'post.created', 'message.created'
  Each payload carries the minimal IDs + fields a consumer needs (no full rows).
- Queue/stream name constants (e.g. STREAM_DOMAIN_EVENTS = 'maidan.events',
  QUEUE_EMBEDDINGS, QUEUE_MODERATION, QUEUE_NOTIFICATIONS) exported as a frozen object.
- Export a JSON-Schema dump of DomainEvent to /packages/shared/contracts/events.schema.json so the
  Python AI service can validate against the same contract.

DoD: package builds, exports are typed, and a test round-trips a sample event through the zod schema
and the JSON-Schema validator with identical results.