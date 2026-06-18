Final hardening pass across apps/api and apps/ai:
- Global error handling, request validation, and a consistent error envelope.
- Rate limiting (Redis-backed) on auth and write endpoints.
- Structured JSON logging with a request/correlation id propagated API->bus->AI workers.
- Token-usage + cost metrics for every Claude call, surfaced on a /internal/metrics endpoint
  (Haiku vs Sonnet split, daily totals) — this is the line that scales steeply, so make it visible.
- Outbox lag, queue depth, websocket connection count as metrics.
- Healthchecks for every dependency (db, redis, anthropic reachability) on /health/ready.
- CI (GitHub Actions): install, typecheck, lint, test for both apps; build Docker images.
- Railway deploy config finalised for two services + managed Postgres & Redis; document required env
  vars and the PhonePe/MSG91/FCM webhook URLs to register. Note the Hetzner graduation path in the
  README (what changes, what doesn't) but don't implement it.

DoD: CI is green; /health/ready reflects real dependency status; killing Redis flips readiness to
unhealthy without crashing the process; a Claude call increments the cost metric.