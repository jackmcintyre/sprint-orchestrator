# sprint-orchestrator unattended runner image.
# Build from the repo root:
#   docker build -f plugins/sprint-orchestrator/packages/sdk-runner/Dockerfile -t sprint-orchestrator-runner .

FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN npm install -g pnpm@9
COPY plugins/sprint-orchestrator/pnpm-workspace.yaml plugins/sprint-orchestrator/package.json plugins/sprint-orchestrator/pnpm-lock.yaml plugins/sprint-orchestrator/tsconfig.base.json ./
COPY plugins/sprint-orchestrator/packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm -r build

FROM node:20-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
# Plugin files needed at runtime (manifest, hooks.json, agents, skills, .mcp.json)
COPY plugins/sprint-orchestrator/.claude-plugin /app/.claude-plugin
COPY plugins/sprint-orchestrator/.mcp.json /app/.mcp.json
COPY plugins/sprint-orchestrator/agents /app/agents
COPY plugins/sprint-orchestrator/skills /app/skills
COPY plugins/sprint-orchestrator/hooks /app/hooks
ENV SPRINT_PROJECT_ROOT=/workspace
WORKDIR /workspace
ENTRYPOINT ["node", "/app/packages/sdk-runner/dist/run.js"]
