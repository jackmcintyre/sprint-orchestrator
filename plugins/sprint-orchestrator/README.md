# sprint-orchestrator

A Claude Code plugin that drives a sprint backlog end-to-end — dev subagents implement
stories, reviewer subagents inspect and approve or bounce them, and a deterministic state
machine keeps everything in order. Hand it a planned sprint, walk away, come back to a
stack of shipped, reviewed PRs.

## 1. Install and run the example

**Prerequisites:**

- [Node.js](https://nodejs.org/) 20 or later
- [pnpm](https://pnpm.io/installation) 9 or later (`npm install -g pnpm`)
- [Claude Code](https://claude.ai/code) installed and running

**Install from the repo:**

```bash
git clone https://github.com/jackmcintyre/claude-dev-loop.git
cd claude-dev-loop
pnpm install        # installs deps and builds the plugin
```

Then inside Claude Code, from the repo root:

```
/plugin install plugins/sprint-orchestrator
```

> **After installing**, restart Claude Code so the new MCP tools register correctly.
> `/reload-plugins` alone is not enough — the deferred-tools registry only refreshes on
> a full restart. If `/sprint-orchestrator:run-sprint` is not visible after install, exit
> and relaunch Claude Code.

**Troubleshooting prerequisites:**

- `pnpm install` fails with "Unsupported engine" → your Node version is below 20. Install
  Node 20+ via [nvm](https://github.com/nvm-sh/nvm) or the official installer, then retry.
- `pnpm: command not found` → run `npm install -g pnpm`, then re-open your terminal.

> **Heads-up — adding or renaming MCP tools requires a full Claude Code restart.**
> `/reload-plugins` reloads the MCP server but does not refresh Claude Code's
> deferred-tools registry, so newly registered tools stay invisible until you exit and
> relaunch. If the orchestrator can't see a tool after an upgrade, restart Claude Code.

**Run the bundled example sprint:**

Open `examples/hello-sprint/` as your project root (or `cd` there), then:

```
/sprint-orchestrator:run-sprint
```

The orchestrator drives the pre-written example backlog through dev and review, printing
a summary when it finishes. See
[`examples/hello-sprint/sprint-status.yaml`](../../examples/hello-sprint/sprint-status.yaml)
for the minimal template you can copy for your own backlog.

**Install from source (for development):**

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

## 2. Use it on your own project

### Step 1 — import your backlog

Use `/sprint-orchestrator:adopt` or `/sprint-orchestrator:adapt-bmad` to create
`sprint-status.yaml` from your planning artifacts (see **Running a sprint** below).
You can also write `sprint-status.yaml` by hand — copy
[`examples/hello-sprint/sprint-status.yaml`](../../examples/hello-sprint/sprint-status.yaml)
as your starting template.

## Running a sprint

### 1. Import your backlog

The orchestrator understands the **adaptor pattern**. The orchestrator core does not import adaptors; adaptors depend on the schema, not the other way round. BMad is one example; the pattern works for any producer that can emit a conforming backlog. No adaptors ship in this sprint; the pattern is documented for future extension.

**If you use BMad for planning** — use the adapt-bmad fast path:

`/sprint-orchestrator:adapt-bmad` is the first concrete adaptor shipped under this pattern: a deterministic, instant fast path for BMad-authored stories. Reach for it when your stories were authored by BMad; reach for universal `/sprint-orchestrator:adopt` for any other source.

```
/sprint-orchestrator:adapt-bmad
```

The convention is a BMad-side authoring responsibility: every BMad story file must include a `## Verification` section containing at least one fenced `shell` block. When the section is missing or empty, `adapt-bmad` refuses the run with a named error — there is no silent fallback.

A minimal Verification section looks like this:

```shell
pnpm --dir plugins/sprint-orchestrator test -- story-one
```

**If you don't use BMad** — use the universal `/sprint-orchestrator:adopt` skill:

```
/sprint-orchestrator:adopt <path>
```

It accepts any external planning context (an epic doc, a brief, a stack of story files,
meeting notes) and drafts a conforming backlog for your review. The flow: source → LLM
subagent drafts → you review (accept / edit / abort) → on accept, `lintSprint` validates
→ write to `sprint-status.yaml`. The skill never writes without your acceptance, and never
writes a draft that doesn't pass `lintSprint`.

### 2. Run the sprint

Once `sprint-status.yaml` exists, use the run-sprint skill:

```
/sprint-orchestrator:run-sprint
```

The wrapper reads `sprint-status.yaml`, computes a turn cap from the story count (`cap = ceil(story_count * turn_cap_per_story)`), and hands the drain condition to `/goal` so the orchestrator keeps going until the backlog is fully resolved (or hits the cap). `turn_cap_per_story` defaults to **3** and can be overridden in `.sprint-orchestrator/config.yaml`.

The wrapper prints the canonical /goal command as the final line of its output, so you can triple-click the last line to copy it.

Paste the /goal command in a fresh context window. A clean transcript gives the /goal evaluator the best chance of correctly deciding when the drain condition is met.

Clipboard auto-copy of the /goal command was investigated this sprint but does not ship — it is tracked as a follow-up. See `_bmad-output/planning-artifacts/follow-ups.md` for the spike notes and promotion criteria.

**Manual override — if you need to invoke `/goal` directly:**

```
/goal /sprint-orchestrator:process-backlog UNTIL every story in sprint-status.yaml is status=done or status=failed, OR stop after <N> turns
```

**Fallback — if `/goal` misbehaves:**

```
/loop 5m /sprint-orchestrator:process-backlog
```

This re-fires on a timer regardless of outcome. It's a fallback, not the primary path.

## 3. Cost transparency

<!-- TODO: Jack to confirm/replace ranges from actual sprint billing data -->

The orchestrator spawns subagents for dev and review work. Here's what to expect:

| Work type | Model | Typical cost |
|-----------|-------|-------------|
| Routine dev + review (small story, under 5 file changes) | Sonnet 4.6 | ~$0.05–$0.20 per story |
| 5-story sprint, no rework | Sonnet 4.6 | ~$0.30–$1.00 total |
| Rework swing (story bounced back by reviewer) | Opus 4.7 | ~$0.20–$0.80 per rework swing |

**Why Opus on rework?** Stories that fail review re-run their dev swing on Opus 4.7 —
roughly 5× the per-token cost of Sonnet, but applied only to the stories that actually
need it. Opus is the escalation model; Sonnet handles everything else.

**Your own Claude Code session model is unaffected — only the dev and reviewer subagents
the orchestrator spawns use these defaults.** Your interactive session continues on
whatever model you have configured.

To override the spawn models, see the configuration reference below.

## 4. Configuration reference

On first run the orchestrator writes `.sprint-orchestrator/config.yaml` automatically. To
pre-configure or customise knobs before the first run, copy the example and edit it:

```bash
cp plugins/sprint-orchestrator/docs/example-config.yaml .sprint-orchestrator/config.yaml
```

See [`docs/example-config.yaml`](./docs/example-config.yaml) for the full list of optional
settings (`turn_cap_per_story`, `pr_per_story`, `force_release_stale`, spawn model
overrides, etc.).

## 5. Architecture / advanced

### Story lifecycle

Each story moves through a deterministic pipeline. The orchestrator owns state transitions;
LLM subagents only handle implementation and review.

```
                   getReadyStories
                          |
                          v
                    +-----------+
                    |   ready   |
                    +-----------+
                          |
                          | claimStory
                          v
                    +-------------+
                    | in_progress |  <-- dev subagent implements
                    +-------------+
                          |
                          | validateAcceptanceCriteria
                          v
                    +-------------+
                    |  validated  |
                    +-------------+
                          |
                          | commitStoryArtefacts
                          v
                    +-------------+
                    |  committed  |  <-- reviewer subagent inspects
                    +-------------+
                        /     \
        recordStorySuccess       recordStoryRework
                      /           \
                     v             v
              +----------+    +-------------+
              | complete |    |   ready     |  (re-queued with notes)
              +----------+    +-------------+
```

Key transitions:

- `getReadyStories` — list unblocked stories whose dependencies are satisfied.
- `claimStory` — atomically reserve a story for one worker (prevents double-claims).
- `validateAcceptanceCriteria` — run the deterministic checks declared in the story spec.
- `commitStoryArtefacts` — stage and commit the implementation diff with a structured message.
- `recordStorySuccess` — finalize a story after reviewer approval.
- `recordStoryRework` — bounce a story back for another attempt with reviewer feedback attached.
- `recordStoryFailure` — give up on a story with a structured reason.
- `recordStoryReopen` — human-only recovery path: transition a `failed` story back to `ready` with an audit-trail entry. Clears `failed_at`, `last_failure_reason`, and the stale claim, but preserves `rework_count` so the prior attempts remain visible. The automated reviewer never calls this — `failed` is a terminal state for the orchestrator.

### Modes

- **One-shot supervised** — install in Claude Code, run the slash command, watch it process up to 5 ready stories, and stop.
- **Recurring unattended (still inside Claude Code)** — keep a Claude Code session open and run `/loop 30m /sprint-orchestrator:process-backlog`. The orchestrator re-fires every 30 minutes, draining ready stories as they become available. Uses your existing Claude Code auth (Max / Pro / API key) — no separate runner needed.

### Computed turn cap

The run-sprint wrapper computes the cap as:

```
cap = ceil(story_count * turn_cap_per_story)
```

`turn_cap_per_story` defaults to **3** and can be overridden in
`.sprint-orchestrator/config.yaml`:

```yaml
turn_cap_per_story: 5
```

So a 7-story sprint with the default cap will run for at most `ceil(7 * 3) = 21` turns
before pausing.

### End-of-run summary lines

Every `process-backlog` run prints one of three distinct final lines so the `/goal`
evaluator (and you, watching the transcript) can tell drain from cap-stop from blocked:

- `Sprint drain confirmed: 0 ready stories remaining. Outcome: <D> done, <F> failed.`
- `Sprint paused at hard cap: <R> ready stories remaining. Outcome so far: <D> done, <F> failed.`
- `Sprint blocked: <reason>. <R> ready stories remaining.`

The leading tokens (`Sprint drain confirmed:`, `Sprint paused at hard cap:`,
`Sprint blocked:`) are stable contracts — grep-by-prefix to disambiguate outcomes in
transcripts or tooling.

### Writing acceptance criteria

Acceptance criteria (`acceptance_criteria.checks` in `sprint-status.yaml`) are the
deterministic gate between "dev says done" and "story is committed". They are only as
strong as you make them.

Guidance:

- **Layer multiple checks.** Combine regex/shell assertions with a real build or test
  invocation. A typical story should have at least one structural check (regex/file-exists)
  plus one behavioural check (`pnpm verify`, `pnpm test`, `tsc --noEmit`, etc.).
- **Avoid bare literal greps as the sole criterion.** `grep "TODO done"` proves nothing.
  Prefer regex patterns that anchor to real code shapes and back them with a command that
  exercises the behaviour.
- **For genuinely-impossible or "do not implement" stories**, use an unreachable assertion
  such as `shell: "false"` or a check that asserts the absence of forbidden patterns.
- **Prefer `expect_exit: 0` shell checks** for anything that has a real test harness.

### Hand-editing sprint-status.yaml

`sprint-status.yaml` is the canonical state file, but it is not the only source of truth —
every transition the orchestrator performs is also appended to `.sprint-orchestrator/run.log`.
Direct edits bypass `run.log` entirely.

This is fine for occasional repair (unsticking a stale claim, fixing a typo in a story
spec), but be aware:

- `run.log` will be **incomplete** for any span where state changed out of band. Audit
  trails, retrospectives, and any tooling that reconstructs history from the log will see a
  gap.
- If you revert `sprint-status.yaml` after a bad run, the log still contains the now-orphaned
  transitions. Consider annotating the log manually, or truncating it alongside the revert if
  you need a clean baseline.
- Prefer the orchestrator's tools (`releaseStaleClaims`, `recordStoryFailure`,
  `recordStoryReopen`, etc.) over hand edits whenever an equivalent tool exists.

### Recovering a failed story

`failed` is a terminal state in the automated workflow: the reviewer cannot walk a story out
of it, and the orchestrator will not retry it on its own. This is intentional — once the
rework cap is hit (or a no-code failure is recorded), the right move is for a human to look
at what went wrong before asking the agents to take another swing.

When you want to put a failed story back into the queue, call the `recordStoryReopen` MCP
tool:

```
recordStoryReopen(storyId: "S1", reason: "deferred dep landed; agent was right to give up first time")
```

What it does:

- Transitions the story from `failed` back to `ready`.
- Clears `failed_at`, `last_failure_reason`, and any stale `claimed_by` / `claimed_at` left
  over from the prior agent.
- **Preserves `rework_count`** so the next reviewer can see the prior attempts in the audit
  trail.
- Appends one entry to `orchestrator.reopen_history` (with timestamp, your reason, and the
  prior failure reason) so the recovery itself is auditable.
- Commits the mutation as `chore(sprint): reopen <id> — <reason>` so the reset shows up in
  git history.

The tool refuses (with `InvalidStateTransitionError`) on any non-`failed` status. To unstick
a stuck `in_progress` claim, use `releaseStaleClaims` instead.

### Known issue: orphan code commit on state-write failure

The reviewer's flow is `validateAcceptanceCriteria → commitStoryArtefacts → recordStorySuccess`.
If the final `recordStorySuccess` call fails for any reason (file lock, schema validation
error, harness classifier intercepts), the code commit produced by `commitStoryArtefacts`
has already landed on the branch with no matching state commit. The state machine is split
between the working tree (committed) and `sprint-status.yaml` (still `in_progress`).

Recovery (4 steps):

1. Hand-edit `sprint-status.yaml`: set the story's `status: ready` and clear `claimed_by` / `claimed_at`.
2. Re-run `/sprint-orchestrator:process-backlog`. The reviewer will re-validate and complete the state transition.
3. Verify by calling `getSprintStatus` (via MCP) — confirm the story is now `status: done` with a fresh `completed_at`.
4. The orphan code commit from before the failure is real and stays in history. Reverting it will undo the work; leave it unless you know you want it gone.

A future sprint will replace this with proper atomic commit-and-mark or rollback-on-failure
semantics. Until then, this is the documented workaround.

## Development

```bash
pnpm -r build       # compile all packages
pnpm -r test        # vitest
pnpm -r typecheck   # tsc --noEmit
pnpm lint           # eslint
```

## License

MIT
