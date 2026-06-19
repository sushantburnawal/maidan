FROM node:18-bookworm-slim AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile=false

COPY packages/shared packages/shared
COPY apps/api apps/api

RUN pnpm --filter @maidan/shared build && pnpm --filter @maidan/api build

FROM node:18-bookworm-slim AS runtime

ENV NODE_ENV="production"
WORKDIR /app

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/apps/api apps/api
COPY --from=build /app/packages/shared packages/shared

EXPOSE 3000

CMD ["node", "apps/api/dist/src/main.js"]
