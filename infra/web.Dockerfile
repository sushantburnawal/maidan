FROM node:18-bookworm-slim AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

ARG VITE_API_BASE_URL=http://localhost:3000
ENV VITE_API_BASE_URL="${VITE_API_BASE_URL}"

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile=false

COPY packages/shared packages/shared
COPY apps/web apps/web

RUN pnpm --filter @maidan/shared build && pnpm --filter @maidan/web build

FROM node:18-bookworm-slim AS runtime

ENV NODE_ENV="production"
ENV HOST="0.0.0.0"
ENV PORT="8080"

WORKDIR /app

COPY --from=build /app/apps/web/dist dist
COPY infra/web-server.mjs infra/web-server.mjs

EXPOSE 8080

CMD ["node", "infra/web-server.mjs"]
