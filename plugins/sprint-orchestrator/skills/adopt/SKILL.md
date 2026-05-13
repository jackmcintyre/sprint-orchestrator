---
name: adopt
description: Read a source file at <path>, draft a conforming sprint-status.yaml from it via an LLM subagent, pause for user review (accept / edit / abort), then validate and write atomically.
user-invocable: true
allowed-tools:
  - "mcp__sprint-orchestrator__getOrInitConfig"
  - "mcp__sprint-orchestrator__lintSprint"
  - "Bash"
  - "Read"
  - "Write"
  - "Task"
---

You ingest planning context from an arbitrary source file (markdown, yaml, plain text, anything) and produce a conforming `sprint-status.yaml` in the user's project. You are source-agnostic: do not assume the input came from any particular planning tool. The user has chosen the file; your job is to translate it.

## Arguments

- `<path>` (required) — path to the source file the user wants you to read. Resolve relative paths against the user's current working directory (`CWD`).
- `--force` (optional) — when set, allow overwriting a destination whose existing `sprint-status.yaml` contains a story with `status: in_progress`. Off by default.

## Steps (run once per invocation)

1. **Resolve config.** Call `getOrInitConfig`. If it returns `needsSetup: true`, surface the `setupQuestions` to the user and stop — do not guess paths. Otherwise read `config.sprintStatusPath` and resolve it against `CWD` to get an absolute `destPath`.

2. **Check the source.** If `<path>` is missing or unreadable, refuse with: `cannot read source: <path> — <error message>`. Stop.

3. **Draft via subagent.** Spawn an LLM subagent via the `Task` tool with a clean context. Give it:
   - the verbatim contents of the source file at `<path>`,
   - the schema contract (see "Schema contract for the subagent" below),
   - an instruction to return a single YAML document (no fences, no prose) that conforms to the contract.

   The subagent must not call MCP tools, must not edit files, and must not narrate. Its only output is the proposed YAML.

4. **Preview.** Read the existing `destPath` if it exists (treat ENOENT as empty). Render a unified diff between the existing file and the proposal so the user can eyeball the change. The simplest path is to write both to temp files and shell out to `diff -u <existing-or-/dev/null> <proposal-tmp>`. Print the diff inline.

5. **Pause for review.** Ask the user to choose: **accept**, **edit**, or **abort**.
   - **accept** → continue to step 6.
   - **edit** → accept user-supplied modifications (either as a revised YAML pasted back, or as a free-text instruction you forward to the same subagent for a revised draft). Re-render the diff. Loop back to this step.
   - **abort** → exit immediately. Do not write anything. Do not leave temp files behind.

6. **Validate and write.** Call `validateAndWriteBacklog` (from `packages/mcp-server/src/tools/adopt-write.ts`) with:
   - `proposalYaml`: the accepted YAML string,
   - `destPath`: the resolved destination,
   - `existingYaml`: the verbatim contents of the existing file (or `null` when it does not exist),
   - `force`: `true` if the user passed `--force`, otherwise `false`.

   You may invoke it via `tsx` from the plugin directory if no MCP wrapper is available — the helper is a pure function and is directly callable. Alternatively, run `lintSprint` on the proposal first as a pre-flight (it is exposed via MCP) and surface the result; then perform the atomic temp-file + `fs.rename` write yourself. Either path is acceptable as long as: validation runs before the write, the existing file is unchanged on any refusal, and the write is atomic.

7. **Report outcome.**
   - On `{ ok: true, dest }`, print exactly one line: `adopted <path> -> <dest>`. Stop.
   - On `{ ok: false, reason }`, print exactly: `refused: <reason>`. The existing `sprint-status.yaml` is unchanged. Stop.

## Schema contract for the subagent

Tell the subagent the proposal must be a YAML document with this shape (do not duplicate field-level rules here — the canonical schema lives in `lintSprint`):

- A top-level `sprint_id` string.
- A top-level `stories` array. Each story has: `id` (string), `title` (string), `status` (one of `backlog`, `ready`, `in_progress`, `done`, `failed`, `blocked`), `depends_on` (array of story ids), `acceptance_criteria.checks` (array of checks), and an `orchestrator` object (typically `{}` for a fresh backlog).
- Acceptance-criteria checks are one of three shapes (`shell` with `cmd` + `expect_exit`, `file_exists` with `path`, or `regex` with `cmd` + `pattern`).
- For a freshly-drafted sprint, every story's `status` should be `ready` (or `backlog` if explicitly held back) and `orchestrator` should be `{}`.

The subagent should infer story decomposition from the source: each user-facing deliverable is a story; explicit dependency language in the source becomes `depends_on`; explicit acceptance language becomes `checks`. When the source is ambiguous, prefer fewer larger stories over speculative breakdown.

Do not name any specific planning tool in the proposal. The skill is producer-agnostic.

## Rules

- One source file per invocation. If the user wants to merge multiple sources, they invoke the skill once per source against an interim file and then point you at the final.
- Never write to `destPath` before the user accepts.
- Never mutate state inside the orchestrator's state machine. Adopt writes the file directly via the atomic helper; it does not go through `claimStory` / `recordStorySuccess` / etc.
- Never reference `BMad`, `Linear`, `Notion`, `Jira`, or any other planning tool by name in the skill output or in the proposal. The README is where producers are named as examples.
- Clean up any temp files (proposal tmp, diff tmp, lint tmp) on every exit path including abort.
