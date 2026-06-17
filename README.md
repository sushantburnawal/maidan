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

## Health Checks

With the local stack running:

```sh
curl http://localhost:3000/health
curl http://localhost:8000/health
```

Both services return a JSON response with `status` set to `ok`.
