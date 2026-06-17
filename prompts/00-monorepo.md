Create a pnpm + turbo monorepo for Maidan with this layout:

  apps/api          NestJS (Fastify) core API
  apps/ai           Python FastAPI AI/worker service
  packages/shared   Shared TypeScript types & zod schemas consumed by apps/api
  infra             Dockerfiles, docker-compose.local.yml, railway config
  db                Supabase migrations (SQL) + seed scripts

Requirements:
- pnpm workspaces + turbo pipeline (build, lint, test, typecheck).
- apps/api: NestJS with Fastify adapter, TS strict mode, eslint+prettier, jest, a /health endpoint
  returning {status:"ok", service:"api", commit:<git sha>}.
- apps/ai: Python project managed with uv, FastAPI app exposing GET /health, ruff + pytest.
- docker-compose.local.yml that brings up: postgres+postgis+pgvector (use the supabase/postgres
  image), redis, the api, and the ai service. Wire healthchecks and depends_on.
- A single .env.example at repo root documenting EVERY env var the system will need (DB, Redis,
  MSG91, PhonePe, FCM, ANTHROPIC_API_KEY, JWT secrets). Group by service with comments.
- README with "make up / make down / make migrate / make seed" targets (a Makefile).
- railway.json (or railway.toml) describing two services (api, ai) and the managed Postgres+Redis
  plugins, with build & start commands.

DoD:
- `pnpm install && pnpm -w build` succeeds.
- `docker compose -f infra/docker-compose.local.yml up` brings all containers to healthy.
- curl localhost:3000/health and localhost:8000/health both return ok.
Do NOT add any business logic yet.