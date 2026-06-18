Flesh out apps/ai (FastAPI, Python 3.12, async). It owns the Meaning plane.

- Config via pydantic-settings (DB URL, REDIS URL, ANTHROPIC_API_KEY, model ids).
- An asyncpg pool to the same Postgres (read for context; write only to AI-owned tables — see below).
- An event-bus consumer that reads STREAM_DOMAIN_EVENTS via a Redis Streams consumer group
  ('maidan-ai'), validates each event against /packages/shared/contracts/events.schema.json,
  and dispatches to handlers by event_type. ACK only after the handler succeeds; build in idempotency
  (track processed event ids). Dead-letter on repeated failure.
- AI-owned tables (new migration in /db, AI-service-role only):
    ai_jobs(id, kind, ref_id, status, payload, result, created_at)
    demand_signals(id, area, pillar, signal_strength, window, evidence jsonb, created_at)
    match_scores(profile_id, activity_id, score, reason, created_at)
- A thin Anthropic client wrapper with two helpers: cheap_call() -> Haiku (prompt caching on, used
  for batched/low-stakes work) and chat_call() -> Sonnet (the conversational agent). Centralise model
  ids, retries, and token accounting/logging here (AI token cost is the steep-scaling line — make it
  observable from day one).

DoD: the consumer starts, joins the group, and a published test event flows to a no-op handler and is
ACKed exactly once. Schema-invalid events go to the dead-letter without crashing the loop.