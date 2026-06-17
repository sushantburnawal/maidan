# Maidan — Agent Operating Instructions

## Project
"Maidan", a hyperlocal wellness & lifestyle marketplace for Bengaluru, India. Two-sided:
Hosts run activities and pay a platform fee; Explorers book and pay Hosts. Activities are
organised under three pillars — Move, Learn, Feel. Canonical example in seeds/tests:
"Hemant's Nandi Hills sunrise trail ride".

## Architecture (do not deviate)
- Core API:   NestJS (Fastify, TypeScript strict), class-validator DTOs.
- AI workers: Python 3.12, FastAPI, async.
- Data (Fact): Supabase = Postgres 15 + PostGIS + pgvector + RLS.
- Now plane:  Redis (cache + BullMQ) + WebSocket gateway.
- Meaning plane: transactional Outbox in Postgres -> Redis Streams -> FastAPI consumers.
- Payments: PhonePe split-settlement. OTP/SMS: MSG91. Push: FCM. Embeddings: self-hosted.
- LLMs: Anthropic Claude — Haiku for moderation/demand-sensing (batched, cached);
        Sonnet for the conversational agent "Sutradhar".
- Hosting: Railway at launch; Hetzner later.

## Principles
- Money and capacity are correctness-critical: DB transactions + row locks, idempotency keys,
  never trust client-supplied amounts.
- Every state change the AI plane cares about is written to the `domain_events` outbox in the
  SAME transaction as the business write. Services never call the queue directly.
- Boring, well-typed code over cleverness. Every module ships with tests.

## How you must work on EVERY task
- Treat all existing code, migrations, table/column names, DTOs, and queue names as a FROZEN
  contract. Read them; never rename or restructure them.
- Do ONLY the scope of the prompt I give you. When its Definition of Done passes, STOP.
  Do not start the next phase or invent extra features.
- Always write and run the tests the prompt asks for. Leave the repo green and committed-ready.
- Ask before destructive operations (dropping data, `db reset`, force-push).

## Allowed Commands
- The agent is permitted to run `docker` commands (e.g., build, run, ps, exec).
- The agent may manage containers relevant to this project workspace.

## Restrictions
- Do not use `sudo` for Docker operations.
- Do not modify system-wide Docker daemon settings.
