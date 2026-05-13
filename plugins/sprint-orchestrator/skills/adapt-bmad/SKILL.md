---
name: adapt-bmad
description: Deterministically convert a BMad output directory (planning-artifacts/epics.md + implementation-artifacts/*.md) into a conforming sprint-status.yaml. No LLM step, no user review prompt — what you put in is what you get.
user-invocable: true
allowed-tools:
  - "mcp__sprint-orchestrator__getOrInitConfig"
  - "Bash"
  - "Read"
---

You convert a BMad-authored planning directory into a conforming `sprint-status.yaml`. The translation is deterministic: a pure helper parses the BMad files and produces YAML, the universal `validateAndWriteBacklog` helper validates and writes it. There is no LLM drafting step and no user review pause — if the input is well-formed, the output is written; if the input is malformed, the skill refuses with a clear reason and writes nothing.

This skill is a sibling of `/sprint-orchestrator:adopt`, not a replacement. Use `/adopt` for any source other than BMad (it is producer-agnostic and LLM-mediated). Use this skill when the source is a BMad output directory and you want instant, repeatable adaption.

## Arguments

- `<bmad-output-dir>` (required) — path to the BMad output directory. Resolve relative paths against the user's current working directory (`CWD`). If the user omits the argument, default to `_bmad-output` resolved against `CWD`.
- `--force` (optional) — when set, allow overwriting a destination whose existing `sprint-status.yaml` contains a story with `status: in_progress`. Passed through verbatim to `validateAndWriteBacklog`.

## Steps (run once per invocation)

1. **Resolve config.** Call `getOrInitConfig`. If it returns `needsSetup: true`, surface the `setupQuestions` to the user and stop. Otherwise read `config.sprintStatusPath` and resolve it against `CWD` to get an absolute `destPath`.

2. **Adapt.** Invoke the pure helper `adaptBmadOutput({ bmadOutputDir })` from `packages/mcp-server/src/tools/adapt-bmad.ts`. The easiest way is to shell out via `tsx`:

   ```shell
   pnpm --silent --dir plugins/sprint-orchestrator exec tsx -e \
     "import('./packages/mcp-server/src/tools/adapt-bmad.ts').then(m => m.adaptBmadOutput({ bmadOutputDir: process.argv[1] })).then(r => process.stdout.write(JSON.stringify(r)))" \
     "<resolved-bmad-output-dir>"
   ```

   Parse the JSON. On `{ ok: false, reason }` print exactly `refused: <reason>` and stop — the existing `sprint-status.yaml` is unchanged.

3. **Validate and write.** On `{ ok: true, proposalYaml }`, read the existing `destPath` if it exists (treat ENOENT as `null`), then call `validateAndWriteBacklog` (from `packages/mcp-server/src/tools/adopt-write.ts`) with:
   - `proposalYaml`: the YAML string returned by the helper,
   - `destPath`: the resolved destination,
   - `existingYaml`: the verbatim contents of the existing file (or `null` when it does not exist),
   - `force`: `true` if the user passed `--force`, otherwise `false`.

4. **Report outcome.**
   - On `{ ok: true, dest }`, print exactly one line: `adapted <bmad-output-dir> -> <dest>`. Stop.
   - On `{ ok: false, reason }`, print exactly: `refused: <reason>`. The existing `sprint-status.yaml` is unchanged. Stop.

## BMad-side authoring convention

The adaptor depends on a specific shape inside the BMad output directory. BMad authors are responsible for producing it; the adaptor refuses cleanly when it isn't satisfied. No silent fallback.

- **Epic doc** at `<bmad-output-dir>/planning-artifacts/epics.md` lists stories in order with H2 or H3 headings of the form:

  ```
  ## Story 1.1: Short title here
  ```

  Each heading becomes one orchestrator story, in document order. The orchestrator-side id is reassigned to a sequential integer (`"1"`, `"2"`, …); the BMad `1.1` / `1.2` key is preserved in the story's `notes` field for traceability.

- **Story files** at `<bmad-output-dir>/implementation-artifacts/<story-key>.md` (where `<story-key>` is the BMad key with dots replaced by dashes — e.g. `1-1.md`). Each story file must contain a `## Verification` section. The section contains one or more fenced shell blocks; each fence becomes one `type: shell` check in the generated `acceptance_criteria.checks`. Example:

  ````
  ## Verification

  ```shell
  pnpm --dir plugins/sprint-orchestrator e2e --grep "my-grep-tag"
  ```
  ````

  Exit code is implicit `0`. To assert a non-zero exit, include a `# expect_exit: <N>` comment line inside the fence — the comment is stripped from the command and applied to `expect_exit`.

- **Dependencies** are inferred sequentially from epic-doc order: story 1 has `depends_on: []`, story 2 has `depends_on: ["1"]`, story 3 has `depends_on: ["2"]`, and so on. Explicit dependency declarations are out of scope for now.

## Rules

- No LLM step. The translation is a pure function; the same input always yields the same output.
- No user review prompt. The user reviews by reading the BMad docs before invoking the skill, not after.
- Never write to `destPath` before `adaptBmadOutput` returns `{ ok: true }` and `validateAndWriteBacklog` accepts.
- Never mutate state inside the orchestrator's state machine. This skill writes the file directly via the atomic helper; it does not go through `claimStory` / `recordStorySuccess` / etc.
- This skill is a sibling of `/adopt`, not a dependency. `/adopt` must remain unaware of BMad's shape.
