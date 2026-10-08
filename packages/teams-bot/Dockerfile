# syntax=docker/dockerfile:1
#
# The Microsoft Teams bot as a container: the Node program (src/main.ts)
# bundled by `build`, listening on TEAMS_BOT_PORT with its SQLite state on
# TEAMS_BOT_STATE_DIR.
#
# Build from the repository root so the shared package is in the context:
#   docker build -f packages/teams-bot/Dockerfile -t open-inspect-teams-bot .

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/teams-bot/package.json packages/teams-bot/
# --ignore-scripts: the root package's prepare script installs git hooks
# through husky, which a workspace-scoped install does not bring along.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --workspace=@open-inspect/shared --workspace=@open-inspect/teams-bot
COPY packages/shared/ packages/shared/
COPY packages/teams-bot/ packages/teams-bot/
RUN npm run build -w @open-inspect/shared \
    && npm run build -w @open-inspect/teams-bot

FROM node:24-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    TEAMS_BOT_PORT=3100 \
    TEAMS_BOT_STATE_DIR=/state
WORKDIR /app
# node:24-slim carries no CA bundle, and Node does not need one: it verifies
# Bot Framework and Entra endpoints against the roots compiled into it.
COPY --from=build /app/packages/teams-bot/dist/main.js packages/teams-bot/dist/main.js
RUN mkdir -p /state && chown node:node /state && chmod 700 /state
USER node
VOLUME ["/state"]
EXPOSE 3100
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.TEAMS_BOT_PORT}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "/app/packages/teams-bot/dist/main.js"]
