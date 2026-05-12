# BMAD Orchestrator Plugin — Build Spec

## Mission

Build a Claude Code plugin called `bmad-orchestrator` that turns BMAD's upfront planning into autonomous-but-supervised sprint execution. The plugin replaces fragile prompt-based orchestration with **deterministic code for state and guardrails**, while keeping the irreducibly LLM-driven parts (story implementation, code review) as thin agent prompts.

The plugin must be usable in two modes from a single codebase:

1. **Interactive supervision** — installed into Claude Code, triggered via `/loop` plus a slash command. The developer watches it run, can intervene, kills the session when done.
2. **Unattended execution** — loaded by a small TypeScript program via `@anthropic-ai/claude-agent-sdk`. Runs as a daemon or scheduled job. Same plugin, no UI.

The first concrete consumer is the Vehicle Agent project. Design must be project-agnostic — Vehicle Agent's planning artefacts (PRD, architecture, stories) live in the standard BMAD v6 layout and the plugin must not hardcode anything specific to it.

## Architecture

```
bmad-orchestrator/
├── .claude-plugin/
│   └── plugin.json                       # plugin manifest
├── README.md                             # install + usage
├── package.json                          # monorepo root (workspaces)
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── packages/
│   ├── mcp-server/                       # deterministic core
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts                  # MCP server entry
│   │   │   ├── tools/                    # one file per tool
│   │   │   ├── state/
│   │   │   │   ├── sprint-status.ts      # read/write/lock
│   │   │   │   └── schema.ts             # zod schemas
│   │   │   ├── validators/
│   │   │   │   └── acceptance.ts         # run AC checks
│   │   │   └── lib/
│   │   │       ├── lock.ts               # file locking
│   │   │       └── logger.ts             # structured logs
│   │   └── __tests__/
│   │       └── *.test.ts                 # vitest, no LLM
│   └── sdk-runner/                       # standalone unattended mode
│       ├── package.json
│       ├── src/
│       │   └── run.ts                    # uses Agent SDK + plugin
│       └── README.md
├── hooks/
│   ├── pre-tool-use.ts                   # guardrails before tool calls
│   ├── post-tool-use.ts                  # format/test after edits
│   └── stop.ts                           # commit + state update
├── skills/
│   └── process-backlog/
│       └── SKILL.md                      # thin orchestrator prompt
└── agents/
    ├── bmad-dev.md                       # implements one story
    └── bmad-reviewer.md                  # reviews against AC
```

## Tech stack

- **TypeScript 5.x**, `strict: true`, `noUncheckedIndexedAccess: true`
- **Node 20+** (LTS)
- **pnpm workspaces** for the monorepo
- **MCP server**: `@modelcontextprotocol/sdk` (stdio transport)
- **SDK runner**: `@anthropic-ai/claude-agent-sdk`
- **Schema validation**: `zod` for every tool input/output and for the state file
- **YAML**: `yaml` (eemeli/yaml) — preserves comments and ordering
- **File locking**: `proper-lockfile`
- **Testing**: `vitest`
- **Linting**: `eslint` with `@typescript-eslint`, `prettier` for formatting
- **Hook scripts**: TypeScript compiled to JS, executed by Node — no Python

No global state. No singletons. Everything injected. Every async function has explicit timeouts.

## Implementation phases

Each phase ships independently. Don't start the next phase until the previous phase's acceptance criteria are met. Open a PR per phase.

### Phase 1 — Skeleton

- Monorepo layout, tsconfig, eslint, prettier, vitest configured
- `plugin.json` manifest with name, version, declared skills/agents/hooks/mcp_servers (even if their files are stubs)
- `README.md` with install steps and a "current status" section
- CI workflow (`.github/workflows/ci.yml`) running typecheck, lint, test
- All stub files exist and `pnpm -r build && pnpm -r test` passes against empty implementations

### Phase 2 — MCP server (deterministic core)

This is where the determinism lives. **No LLM calls in this package, ever.** State transitions go through code we can unit-test.

Implement these tools. All inputs and outputs validated with zod. All errors thrown as typed `BmadError` subclasses with structured fields.

#### Tools to implement

| Tool | Input | Output | Behaviour |
|---|---|---|---|
| `getSprintStatus` | — | `SprintStatus` | Reads `sprint-status.yaml`, returns whole file structured |
| `getReadyStories` | — | `Story[]` | Returns stories where `status == "ready"` and all `depends_on` stories are `done` |
| `getStoryContext` | `storyId: string` | `{ story, prdExcerpts, architectureExcerpts }` | Reads the story file and pulls related PRD/architecture sections by reference IDs (e.g. FR-015) |
| `claimStory` | `storyId: string, agentId: string` | `{ claimed: boolean, holder?: string }` | Atomic: lock file, re-read status, set `status: in_progress` and `claimed_by: agentId` only if currently `ready`. Returns `false` if already claimed. |
| `markStoryComplete` | `storyId: string, summary: string, artefacts: string[]` | `void` | Lock, validate current status is `in_progress` and claimed by caller, run `validateAcceptanceCriteria`, on pass set `done` with timestamp + summary |
| `markStoryFailed` | `storyId: string, reason: string` | `void` | Lock, set `status: blocked`, write reason. Never silently retry. |
| `validateAcceptanceCriteria` | `storyId: string` | `{ passed: boolean, results: CheckResult[] }` | Reads story's `acceptance_criteria.checks` block, runs each check (shell command, file existence, regex against output). Pure function over the project state, no side effects. |
| `releaseStaleClaims` | `olderThanMinutes: number` | `string[]` | Returns story IDs whose `claimed_at` is older than threshold; resets them to `ready`. For recovering from crashed agents. |

#### State file (sprint-status.yaml)

The plugin must be tolerant of BMAD writing this file. The plugin owns one top-level namespace, `orchestrator:`, and **never writes anywhere else** unless BMAD explicitly declares a story status (in which case the plugin updates only the status field and adds its metadata under `orchestrator:`).

Minimum schema (zod, in `state/schema.ts`):

```ts
const StoryStatus = z.enum(["backlog", "ready", "in_progress", "done", "blocked"]);

const Story = z.object({
  id: z.string(),                          // e.g. "E1-S3"
  title: z.string(),
  status: StoryStatus,
  depends_on: z.array(z.string()).default([]),
  acceptance_criteria: z.object({
    checks: z.array(z.discriminatedUnion("type", [
      z.object({ type: z.literal("shell"), cmd: z.string(), expect_exit: z.number().default(0) }),
      z.object({ type: z.literal("file_exists"), path: z.string() }),
      z.object({ type: z.literal("regex"), cmd: z.string(), pattern: z.string() }),
    ])).default([]),
  }).default({ checks: [] }),
  orchestrator: z.object({
    claimed_by: z.string().optional(),
    claimed_at: z.string().datetime().optional(),
    completed_at: z.string().datetime().optional(),
    summary: z.string().optional(),
    last_failure_reason: z.string().optional(),
  }).default({}),
});

const SprintStatus = z.object({
  sprint_id: z.string(),
  stories: z.array(Story),
});
```

Tolerate unknown fields — pass them through on write so we don't clobber BMAD's own additions.

#### Locking

Every read-modify-write of `sprint-status.yaml` goes through `proper-lockfile.lock(path, { retries: { retries: 5, factor: 2, minTimeout: 50, maxTimeout: 1000 } })`. Functions that only read may skip the lock. Write functions throw `LockTimeoutError` after retries are exhausted — never proceed without the lock.

#### Tests

Unit test every tool. Test cases must include:

- Two concurrent `claimStory` calls — exactly one succeeds
- `markStoryComplete` rejecting if caller isn't the claimer
- `markStoryComplete` rejecting if `validateAcceptanceCriteria` fails
- `getReadyStories` excluding stories whose deps aren't `done`
- State file with BMAD-added unknown fields preserved after a write
- `releaseStaleClaims` only touching truly stale claims
- Corrupt YAML throwing a typed error, not crashing

Coverage: aim for ≥90% on `packages/mcp-server/src`.

### Phase 3 — Hooks (guardrails)

Hooks are TypeScript executed via `node --import tsx`. The plugin manifest registers them at the correct lifecycle events.

#### `pre-tool-use.ts`

Receives the pending tool call on stdin (JSON). Decides allow/deny. Reject conditions:

- `Bash` commands matching destructive patterns: `rm -rf /`, `rm -rf ~`, `:(){:|:&};:`, `dd if=...of=/dev/`, anything piping `curl | sh`, anything writing outside the project root
- `Write` or `Edit` with absolute paths outside the project root, or relative paths that resolve outside
- Network calls (`WebFetch`, `WebSearch`) to domains not in the allowlist (allowlist read from `.bmad-orchestrator/allowed-domains.txt`, default empty meaning deny all)

Patterns live in `hooks/lib/deny-patterns.ts` and are unit-tested independently — never have a regex in the hook that isn't tested.

The hook prints a JSON object to stdout: `{ "decision": "allow" | "deny", "reason"?: string }`. On deny, the reason is shown to the model so it can adapt.

#### `post-tool-use.ts`

Receives the completed tool call and its result. Actions:

- After `Write` or `Edit` to `*.ts` / `*.tsx` / `*.js`: run `pnpm prettier --write <file>` synchronously
- After `Bash` running the test suite (configurable matcher): parse exit code, append a structured event to `.bmad-orchestrator/run.log`
- Never block — this hook is informational only

#### `stop.ts`

Fires when the agent completes a turn. Actions:

- If a story is currently claimed by this agent (check via MCP):
  - Call `validateAcceptanceCriteria`
  - On pass: `git add -A && git commit -m "feat(${storyId}): ${title}"` then `markStoryComplete`
  - On fail: `markStoryFailed` with structured reason; do not commit
- If no story is claimed, exit silently

Hooks have unit tests with mocked stdin/stdout and a temp git repo fixture.

### Phase 4 — Skills & agents (thin orchestration)

These are the only markdown files in the plugin and they must stay thin. **Business logic is forbidden here.** If a skill or agent contains a conditional like "if the story has X, do Y," it belongs in the MCP server.

#### `skills/process-backlog/SKILL.md`

Frontmatter declares `user-invocable: true`, `allowed-tools: ["mcp__bmad-orchestrator__*", "Task"]`. Body is roughly:

> You are processing the BMAD sprint backlog. Do the following loop until `getReadyStories` returns an empty array or you've completed 5 stories this run (hard cap to protect context):
>
> 1. Call `getReadyStories`. If empty, summarise what was done and exit.
> 2. For each ready story (up to your concurrency budget — default 1), call `claimStory` with a fresh agent ID.
> 3. For each claimed story, spawn a Task subagent of type `bmad-dev`, passing the story ID. Wait for it to return.
> 4. When the dev subagent returns, spawn `bmad-reviewer` for the same story.
> 5. The reviewer either marks the story complete or marks it failed via the MCP tools — you do not call those tools yourself.
> 6. Loop.
>
> Report a one-line status after each story. Do not narrate intermediate work.

#### `agents/bmad-dev.md`

Body: a prompt that says "given a story ID, fetch its context via `getStoryContext`, implement the change, and signal completion." Subagent has `allowed-tools` including read/write/edit/bash but NOT the MCP `mark*` tools — only the reviewer marks status.

#### `agents/bmad-reviewer.md`

Body: a prompt that says "given a story ID, verify the implementation against acceptance criteria by calling `validateAcceptanceCriteria`, inspect the diff, then call either `markStoryComplete` or `markStoryFailed`." This subagent's allowed-tools include the `mark*` MCP calls.

These agent files exist to **route work to subagents with the right tool permissions** — that's the entire point. The actual logic of "did the AC pass" is in the MCP server.

### Phase 5 — SDK runner (production deployment)

Standalone TypeScript program in `packages/sdk-runner` that loads the plugin and runs the loop without Claude Code.

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as path from "node:path";

const pluginPath = path.resolve(__dirname, "../../..");

async function main() {
  const startedAt = Date.now();
  const maxRuntimeMs = 4 * 60 * 60 * 1000; // 4h ceiling

  while (Date.now() - startedAt < maxRuntimeMs) {
    let didWork = false;

    for await (const event of query({
      prompt: "/bmad-orchestrator:process-backlog",
      options: {
        plugins: [{ type: "local", path: pluginPath }],
        maxTurns: 100,
        canUseTool: async (name, input) => {
          // delegate to a TS policy module; deny by default
        },
      },
    })) {
      // log every event as structured JSON to stdout
      // track whether any story moved to "done" this iteration
    }

    if (!didWork) break; // backlog empty
    await new Promise(r => setTimeout(r, 30_000));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
```

Requirements:

- Structured JSON logs to stdout (one line per event), human logs to stderr
- Graceful shutdown on SIGTERM/SIGINT — finishes the current story, then exits
- Exit codes: `0` backlog empty, `1` unrecoverable error, `2` max runtime hit
- `Dockerfile` that runs this as the entrypoint, ready to drop into a container

Integration test: spin up the runner against a fixture sprint with two stories whose acceptance criteria are trivial shell checks (`test -f hello.txt`). Verify both stories transition to `done` and the runner exits 0.

## State model — sprint-status.yaml example

```yaml
sprint_id: vehicle-agent-sprint-1
stories:
  - id: E1-S1
    title: "Set up project scaffolding"
    status: done
    depends_on: []
    acceptance_criteria:
      checks:
        - type: shell
          cmd: pnpm install --frozen-lockfile
        - type: file_exists
          path: tsconfig.json
    orchestrator:
      completed_at: "2026-05-12T08:14:22Z"
      summary: "Initialised pnpm workspace with TS strict config."
  - id: E1-S2
    title: "Add vehicle status fetcher"
    status: ready
    depends_on: [E1-S1]
    acceptance_criteria:
      checks:
        - type: shell
          cmd: pnpm test --filter vehicle-status
        - type: regex
          cmd: pnpm test --filter vehicle-status
          pattern: "Tests\\s+\\d+ passed"
```

## Quality requirements

- TypeScript strict mode, no `any` (use `unknown` and narrow)
- Every public function has a JSDoc with `@throws` documented
- Every tool input/output validated through zod, even internally — defence in depth
- No `process.exit()` outside `main()` entry points
- Structured logging via pino or similar — never `console.log` in library code
- Test coverage ≥90% on `mcp-server`, ≥80% on `hooks`, ≥70% on `sdk-runner`
- A pre-commit hook runs typecheck + lint + test on changed packages

## Non-goals — explicit don'ts

- **Do not** put any LLM call inside `packages/mcp-server`. Ever. It's the deterministic layer.
- **Do not** put business logic in skill/agent markdown. If a markdown file describes a decision tree, that decision tree goes in TypeScript.
- **Do not** write to anywhere in `sprint-status.yaml` outside the `orchestrator:` namespace except for the top-level `status` field (which BMAD owns the schema for but the plugin transitions).
- **Do not** implement retries inside `markStoryFailed`. Failure is signalled and surfaced. The human or a later run decides whether to retry.
- **Do not** add a database. The state file is the source of truth. If we later need an index, build it as a derived cache.
- **Do not** rely on `--dangerously-skip-permissions` in any documentation, README, or test. The whole point is that we don't need it.
- **Do not** add metrics/telemetry to a third-party service in v1. Logs to disk are enough.

## Acceptance criteria for the whole plugin

- [ ] `claude plugin install ./bmad-orchestrator` (or local path equivalent) succeeds
- [ ] `/bmad-orchestrator:process-backlog` invoked in Claude Code on a fixture project drives at least one story from `ready` to `done`
- [ ] Two concurrent invocations of the orchestrator on the same backlog don't double-claim a story (integration test)
- [ ] A pre-tool-use rejection (e.g. agent tries `rm -rf /tmp`) is surfaced to the model and execution continues
- [ ] The SDK runner executes the same fixture end-to-end with no human interaction and exits 0
- [ ] `pnpm -r build && pnpm -r test && pnpm -r lint && pnpm -r typecheck` all pass in CI
- [ ] Total external dependencies kept under 20 production packages across all workspaces (sanity check against drift)

## Open questions to confirm before starting

1. **Package manager**: spec says pnpm — confirm or switch to npm/bun.
2. **BMAD version target**: assume v6 (current). If you're still on v5 in Vehicle Agent, the `sprint-status.yaml` schema may differ — share an example file and I'll update the zod schema.
3. **Commit attribution**: should commits made by `stop.ts` use a co-author trailer for the agent, or attribute solely to the human? I'd suggest co-author for traceability.
4. **Subagent concurrency**: default to 1 (sequential) in v1, or allow `MAX_PARALLEL_STORIES` env var from day one? Sequential is simpler and avoids the worktree complexity; parallel can be a Phase 6.
5. **License**: MIT, Apache-2.0, or private? Affects whether this becomes a publishable artefact later.

## Suggested execution order

If you (Claude Code) hit a wall on any phase, stop and ask rather than improvise — the phases are deliberately independent. Open one PR per phase against `main`, with the phase number and a one-line summary in the PR title. Each PR should leave the plugin in a working state (the next phase's files can be stubs but must compile).

Start with Phase 1.
