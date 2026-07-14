# Railway Private Pilot Launch Plan

## Summary

Deploy Maidan to Railway as a private pilot for the first real user, with three services: `api`, `ai`, and a new `web` service. Use Railway managed Postgres and Redis, production PhonePe from day one, Firebase Google sign-in, and keep the existing queue names, DTOs, and outbox contracts unchanged.

Success criteria: one invited Explorer can create an account through Google sign-in, browse/book an activity, pay through live PhonePe, trigger the payment webhook, receive a confirmed booking, and access chat/profile flows on the deployed web app.

## Key Changes

- Extend Railway deployment from the existing `api` + `ai` setup to include `web`.
- Build `apps/web` with `VITE_API_BASE_URL=https://<api-domain>`.
- Serve the built Vite app as a Railway service.
- Set API `CORS_ORIGIN=https://<web-domain>`.
- Configure the Railway web domain as an authorized Firebase Authentication domain.
- Keep API and AI Dockerfile-backed services as-is unless verification reveals build/start issues.
- Provision Railway Postgres and Redis, then apply existing `db/migrations/*.sql` in order using the current migration workflow against the Railway `DATABASE_URL`.
- Seed only launch-safe data: the first Host profile, one pilot activity, and one bookable slot.
- Avoid broad demo seed data unless explicitly needed for the pilot.
- Configure production vendor credentials:
  - Firebase Auth: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, and the web `VITE_FIREBASE_*` config values.
  - MSG91: keep configured only if phone OTP compatibility remains needed.
  - PhonePe: production base/auth URLs, client credentials, merchant ID, webhook credentials/secret, split settlement settings, platform fee settings, Maidan merchant reference.
  - Anthropic: production Claude keys/model env for AI readiness and Sutradhar/moderation.
  - FCM: configure credentials only if push is part of the first pilot; otherwise disable notification worker or treat push as non-blocking.
- Register callbacks after Railway domains exist:
  - PhonePe webhook: `https://<api-domain>/payments/webhook`
  - PhonePe redirect: `https://<api-domain>/payments/return`
  - MSG91 delivery callback: do not register, because no callback endpoint exists.

## Launch Sequence

1. Create Railway project with managed Postgres and Redis.
2. Add services:
   - `api` from `infra/api.Dockerfile`
   - `ai` from `infra/ai.Dockerfile`
   - `web` from a new static-serving Dockerfile or Railway-compatible Vite static service.
3. Set shared env:
   - `DATABASE_URL`, `POSTGRES_SSL=true`, `REDIS_URL`
   - `BULLMQ_PREFIX`, `STREAM_DOMAIN_EVENTS`, queue names
   - `COMMIT_SHA`, `LOG_LEVEL`
4. Set service-specific env exactly from `.env.example`/README, replacing placeholders with real secrets.
5. Deploy `api` and `ai`, then verify:
   - `GET /health`
   - `GET /health/ready`
   - `GET /internal/outbox/health`
   - `GET /internal/metrics`
6. Apply migrations to Railway Postgres.
7. Create pilot data: first Host profile, payout reference, activity, and one bookable slot.
8. Deploy `web`, verify it calls the Railway API and websocket endpoint.
9. Register PhonePe production callback URLs and run a controlled live payment.
10. Invite the first user and monitor the full journey.

## Test Plan

- Before deploy:
  - `pnpm -w build`
  - `pnpm -w test`
  - `cd apps/ai && uv run pytest`
  - Existing smoke flow where local infra is available.
- After deploy:
  - API readiness returns healthy for DB, Redis, AI.
  - AI readiness returns healthy for DB, Redis, and Anthropic.
  - Google sign-in returns a Firebase ID token that the API verifies and exchanges for Maidan access/refresh JWTs.
  - Firebase Google auth creates/reuses the `profiles` row with nullable phone and unique Firebase UID.
  - Booking creation locks capacity correctly and writes `domain_events`.
  - Payment init creates a PhonePe order using server-side amount calculation.
  - PhonePe webhook marks payment terminal state and emits payment outbox event.
  - Outbox relay drains `domain_events` into Redis stream/BullMQ.
  - Web app can log in, browse, book, pay, and open chat from the Railway domain.
- Manual failure checks:
  - Invalid, non-Google, or unverified-email Firebase tokens fail.
  - Duplicate webhook is idempotent.
  - Payment amount mismatch is rejected.
  - Killing Redis or breaking AI URL flips `/health/ready` unhealthy.

## Assumptions

- Launch posture is private pilot, not public beta.
- PhonePe uses production credentials immediately.
- Web is hosted on Railway as a third service.
- No schema/table/DTO/queue renames are allowed.
- No destructive DB reset is used on Railway; migrations are applied forward only.
- If PhonePe production onboarding blocks callback activation, the fallback is to deploy everything production-like but gate first payment until PhonePe approval is complete.
