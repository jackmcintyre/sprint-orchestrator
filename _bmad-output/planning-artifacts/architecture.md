# sprint-orchestrator

A Claude Code plugin that turns sprint backlogs into autonomous-but-supervised execution. Deterministic state and guardrails live in TypeScript; the LLM only does the irreducibly fuzzy parts (implementation, review).

Works standalone or with BMAD v6 planning artefacts. When BMAD layout is detected, the plugin auto-configures; otherwise it asks once where your PRD / architecture / story files live.

## Status

**Phase 1 — skeleton.** Scaffolding only. Tools, hooks, and agents are stubs. See `project.md` for the full build spec.

## Install

```bash
git clone <this-repo>
cd sprint-orchestrator
pnpm install
pnpm -r build
```

Then in Claude Code:

```
/plugin install <path-to-this-repo>
```

## Usage

```
/sprint-orchestrator:process-backlog
```

On first run in a project, the plugin asks where your planning docs live (or detects BMAD v6 layout automatically) and writes `.sprint-orchestrator/config.yaml`.

## Modes

- **One-shot supervised** — install in Claude Code, run the slash command, watch it process up to 5 ready stories, and stop.
- **Recurring unattended (still inside Claude Code)** — keep a Claude Code session open and run `/loop 30m /sprint-orchestrator:process-backlog`. The orchestrator re-fires every 30 minutes, draining ready stories as they become available. Uses your existing Claude Code auth (Max / Pro / API key) — no separate runner needed.

## Development

```bash
pnpm -r build       # compile all packages
pnpm -r test        # vitest
pnpm -r typecheck   # tsc --noEmit
pnpm lint           # eslint
```

## License

MIT
