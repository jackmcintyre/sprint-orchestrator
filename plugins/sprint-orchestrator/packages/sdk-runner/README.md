# @sprint-orchestrator/sdk-runner

Unattended runner for the sprint-orchestrator plugin. Loads the plugin via `@anthropic-ai/claude-agent-sdk` and drives `/sprint-orchestrator:process-backlog` until the backlog drains, an unrecoverable error occurs, or the 4-hour ceiling is hit.

## Run locally

```bash
pnpm -r build
ANTHROPIC_API_KEY=... \
  SPRINT_PROJECT_ROOT=/path/to/your/sprint-project \
  node packages/sdk-runner/dist/run.js
```

## Logs

- **stdout**: one JSON object per line. `run_started`, `sdk_event`, `iteration_complete` (with `newlyDone: [storyId, …]`), `backlog_empty`, `iteration_error`, `max_runtime_hit`, `shutdown`.
- **stderr**: human-readable status; nothing structured here.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Backlog empty (or graceful shutdown via SIGTERM/SIGINT) |
| `1` | Unrecoverable error during an iteration |
| `2` | 4-hour runtime ceiling hit |

## Permission policy

`canUseTool` denies every tool by default. Only these are allowed:

- Built-ins: `Read`, `Write`, `Edit`, `MultiEdit`, `Bash`, `Glob`, `Grep`, `Task`
- Anything namespaced `mcp__sprint-orchestrator__*`

If you grant a new tool to an agent in `agents/*.md`, mirror the change in `packages/sdk-runner/src/policy.ts`.

## Docker

```bash
docker build \
  -f plugins/sprint-orchestrator/packages/sdk-runner/Dockerfile \
  -t sprint-orchestrator-runner \
  .

docker run --rm \
  -e ANTHROPIC_API_KEY \
  -v /path/to/your/sprint-project:/workspace \
  sprint-orchestrator-runner
```

## Graceful shutdown

SIGTERM and SIGINT mark the run for shutdown; the current iteration completes (so a story in flight isn't truncated), then the process exits with code 0.
