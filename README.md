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
```

Both services return a JSON response with `status` set to `ok`.

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
