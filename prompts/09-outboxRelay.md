Wire the Now plane and the bridge from Fact->Meaning.

1) Redis module shared across the API (cache + queues). Configure BullMQ with the queue names from
   packages/shared (QUEUE_EMBEDDINGS, QUEUE_MODERATION, QUEUE_NOTIFICATIONS).
2) Outbox relay: a background worker inside apps/api (or a tiny standalone process — your call, but
   document it) that polls domain_events WHERE processed_at IS NULL ordered by id, and for each:
   - XADD it onto the Redis Stream STREAM_DOMAIN_EVENTS (the event bus the AI service consumes),
   - additionally enqueue derived BullMQ jobs where useful (e.g. 'activity.published' ->
     QUEUE_EMBEDDINGS; 'post.created'/'message.created' -> QUEUE_MODERATION;
     'booking.confirmed' -> QUEUE_NOTIFICATIONS),
   - mark processed_at in the same step. Use SELECT ... FOR UPDATE SKIP LOCKED so multiple relay
     instances are safe. At-least-once delivery is fine; consumers must be idempotent.
3) Expose a /internal/outbox/health metric: count of unprocessed events + oldest age.

DoD: an integration test inserts a domain_events row, runs one relay tick, and asserts the event
appears on the Redis stream, the derived BullMQ job is enqueued, and processed_at is set. A second
tick does nothing.