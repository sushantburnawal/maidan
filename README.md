# Maidan

Maidan is a hyperlocal wellness and lifestyle marketplace for Bengaluru. This repository is the initial monorepo scaffold for the NestJS API, FastAPI AI service, shared TypeScript schemas, local infrastructure, and Supabase database files.

## Layout

- `apps/api` - NestJS core API using the Fastify adapter.
- `apps/ai` - Python FastAPI AI and worker service managed with `uv`.
- `packages/shared` - Shared TypeScript types and zod schemas.
- `infra` - Dockerfiles, local Docker Compose, and Railway configuration.
- `db` - Supabase SQL migrations and seed scripts.

## Local Commands

Install dependencies and build the TypeScript workspace:

```sh
pnpm install
pnpm -w build
```

Run the local stack:

```sh
make up
```

Stop the local stack:

```sh
make down
```

Apply SQL migrations:

```sh
make migrate
```

Run seed scripts:

```sh
make seed
```

Backfill activity embeddings after seeding:

```sh
pnpm --filter @maidan/ai embeddings:backfill
```

## Health Checks

With the local stack running:

```sh
curl http://localhost:3000/health
curl http://localhost:8000/health
curl http://localhost:3000/health/ready
curl http://localhost:8000/health/ready
```

`/health` is the shallow liveness check. `/health/ready` checks real dependencies: API checks
Postgres, Redis, and the AI service; AI checks Postgres, Redis, and Anthropic reachability. If Redis
is stopped, readiness returns `503` with the failing check and the process stays up.

## Internal Metrics

Operational metrics are exposed as JSON:

```sh
curl http://localhost:3000/internal/metrics
curl http://localhost:8000/internal/metrics
```

The API endpoint reports outbox lag, BullMQ queue depths, and websocket connection count. The AI
endpoint reports Claude token usage and estimated cost split by Haiku and Sonnet with daily totals.
Anthropic token prices are configured through `ANTHROPIC_*_USD_PER_MTOK` env vars; keep them aligned
with Claude Platform pricing when models or pricing change.

## Outbox Relay

The API runs the Fact-to-Meaning outbox relay in-process through `OutboxModule`. It polls
`domain_events where processed_at is null`, publishes each event to the shared Redis stream
`STREAM_DOMAIN_EVENTS`, enqueues derived BullMQ jobs on the shared queue constants, and then marks the
row processed. The runner is enabled by default outside Jest and can be controlled with:

```sh
OUTBOX_RELAY_ENABLED=true
OUTBOX_RELAY_INTERVAL_MS=5000
OUTBOX_RELAY_BATCH_SIZE=50
```

Relay lag is exposed at:

```sh
curl http://localhost:3000/internal/outbox/health
```

## Railway Deployment

`infra/railway.json` defines two Dockerfile-backed services, `api` and `ai`, plus managed Postgres
and Redis plugins. Both services use `/health/ready` for deploy healthchecks.

Required shared env vars:

```sh
COMMIT_SHA
DATABASE_URL
POSTGRES_SSL
REDIS_URL
BULLMQ_PREFIX
STREAM_DOMAIN_EVENTS
QUEUE_EMBEDDINGS
QUEUE_MODERATION
QUEUE_NOTIFICATIONS
LOG_LEVEL
```

Required API env vars:

```sh
HOST
PORT
AI_BASE_URL
AI_INTERNAL_TOKEN
JWT_ACCESS_SECRET
JWT_REFRESH_SECRET
JWT_ACCESS_TTL
JWT_REFRESH_TTL
RATE_LIMIT_AUTH_MAX
RATE_LIMIT_AUTH_WINDOW_SECONDS
RATE_LIMIT_WRITE_MAX
RATE_LIMIT_WRITE_WINDOW_SECONDS
MSG91_AUTH_KEY
MSG91_SENDER_ID
MSG91_OTP_TEMPLATE_ID
PHONEPE_BASE_URL
PHONEPE_AUTH_URL
PHONEPE_CLIENT_ID
PHONEPE_CLIENT_VERSION
PHONEPE_CLIENT_SECRET
PHONEPE_MERCHANT_ID
PHONEPE_WEBHOOK_USERNAME
PHONEPE_WEBHOOK_PASSWORD
PHONEPE_WEBHOOK_SECRET
PHONEPE_SPLIT_SETTLEMENT_ENABLED
PLATFORM_FEE_PCT
PLATFORM_FEE_FLOOR_INR
MAIDAN_PHONEPE_MERCHANT_REF
FCM_PROJECT_ID
FCM_CLIENT_EMAIL
FCM_PRIVATE_KEY
```

Required AI env vars:

```sh
PORT
AI_INTERNAL_TOKEN
ANTHROPIC_API_KEY
ANTHROPIC_HAIKU_MODEL
ANTHROPIC_SONNET_MODEL
ANTHROPIC_HAIKU_INPUT_USD_PER_MTOK
ANTHROPIC_HAIKU_OUTPUT_USD_PER_MTOK
ANTHROPIC_HAIKU_CACHE_WRITE_USD_PER_MTOK
ANTHROPIC_HAIKU_CACHE_READ_USD_PER_MTOK
ANTHROPIC_SONNET_INPUT_USD_PER_MTOK
ANTHROPIC_SONNET_OUTPUT_USD_PER_MTOK
ANTHROPIC_SONNET_CACHE_WRITE_USD_PER_MTOK
ANTHROPIC_SONNET_CACHE_READ_USD_PER_MTOK
EMBEDDINGS_MODEL
EMBEDDINGS_DIMENSIONS
EMBEDDINGS_DEVICE
```

Register these external callback URLs after Railway assigns the API domain:

```text
PhonePe payment webhook: https://<api-domain>/payments/webhook
PhonePe payment redirect: https://<api-domain>/payments/return
MSG91 delivery callback: not implemented; do not register a callback until an API endpoint exists.
FCM server webhook: not applicable; configure FCM credentials and app/web origins instead.
```

## Hetzner Graduation Path

When moving off Railway, keep the service contracts unchanged: API remains NestJS/Fastify, AI remains
FastAPI, Postgres remains Postgres 15 with PostGIS/pgvector/RLS, Redis remains the cache/BullMQ/stream
plane, and the transactional outbox remains the API-to-AI boundary. What changes is infrastructure:
run the two Docker images under a Hetzner VM or Kubernetes control plane, provision managed or
self-operated Postgres and Redis, terminate TLS at a reverse proxy, and point the same env vars and
webhook URLs at the new domains. No application protocol or queue/table name changes are part of the
graduation.
