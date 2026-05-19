---
description: Ship one story end-to-end through the BMad cycle in an isolated worktree, verifying every acceptance criterion before opening a PR. Use when the user says "ship story X", "/ship-story", or asks to run the per-story implementation cycle.
---

# Ship Story

Drive a single story from `backlog` → open PR using sequential BMad subagents in an isolated git worktree. Deterministic plumbing (story resolution, AC extraction, status mutation, PR body assembly, run state) is handled by `scripts/ship.py`. Your job as orchestrator is the judgment work: spawning subagents and gating on their results.

## Invocation

- `/ship-story` — picks the next eligible `backlog` story
- `/ship-story 1-1` — works that story (prefix-matched against story keys)

## Architecture

You are the orchestrator. You do NOT write story specs, code, tests, or reviews — you spawn subagents for each. You call `scripts/ship.py <subcommand>` for every deterministic operation. The script is the source of truth for: which story is next, what its ACs are, what the worktree path is, when an AC table counts as green, what the PR body looks like, what status transitions are legal.

Run-state is persisted as JSONL in `.claude/skills/ship-story/.runs/<story-key>.jsonl`. Every milestone is recorded; on a halt, you can resume by reading state.

## Execution

Let `SH=python3 .claude/skills/ship-story/scripts/ship.py` for brevity below.

### Step 1 — Preflight

```bash
$SH preflight
```

Halts if working tree is dirty, gh is unauthed, or required paths are missing. Non-zero exit → halt the skill and surface stderr.

### Step 2 — Resolve story

```bash
$SH resolve [<story_id>]
```

Returns JSON with `story_key`, `story_short`, `title`, `epic_num`, `epic_file`, `spec_path`, and `acceptance_criteria[]`. Save the JSON to `/tmp/ship-<story_key>.resolve.json` — you'll reuse it in Step 9.

Print the story title and AC count to the user.

```bash
$SH record <story_key> resolved
```

### Step 3 — Create the worktree

```bash
$SH worktree <story_key>
```

Fails closed if path exists, branch exists, or origin/main can't be fetched. Returns JSON with `worktree` path and `branch`. All subsequent file/test/git ops happen inside the worktree.

```bash
$SH record <story_key> worktree_ready --data '{"path":"..."}'
```

### Step 4 — Author the story spec (subagent: bmad-create-story)

Spawn ONE subagent. Prompt:

> Run the `bmad-create-story` skill (action: `create`) for story key `<story_key>`. The epic source is `<epic_file>`. Output the spec to `<spec_path>`. Do NOT implement code — spec only. Do NOT modify `sprint-status.yaml` or any other status/state file — the orchestrator owns status transitions. Do NOT pause for clarifying questions; make reasonable defaults and proceed.

Verify `<spec_path>` exists. Then:

```bash
$SH set-status <story_key> ready-for-dev
$SH record <story_key> spec_authored
```

**Status writes:** Only `ship.py set-status` mutates `sprint-status.yaml`. Every subagent prompt in this skill must include the "do not touch sprint-status.yaml" clause. If a subagent reports having moved status, the orchestrator's `set-status` call is the authoritative one — verify post-run via `$SH state <story_key>`.

### Step 5 — Validate the spec (subagent: bmad-create-story validate)

Cheap insurance — a malformed spec wastes a full dev+review cycle. Spawn ONE subagent. Prompt:

> Run the `bmad-create-story` skill with action `validate` against `<spec_path>`. Return the validation report verbatim and a single-word verdict: `pass` or `fail`. Do NOT modify `sprint-status.yaml`. Do NOT pause for clarifying questions.

If verdict is `fail` → halt with `SPEC_VALIDATION_FAILED`, surface the report, and record:

```bash
$SH record <story_key> spec_validation_failed --data '{"report":"..."}'
```

If `pass`:

```bash
$SH record <story_key> spec_validated
```

### Step 6 — Implement (subagent: bmad-dev-story)

Spawn ONE subagent. Prompt:

> Run `bmad-dev-story` against `<spec_path>`. Your working directory is the worktree at `<worktree_path>`. Implement code and unit tests. Run `pnpm install && pnpm build && pnpm test` (or the project's equivalent) from the relevant package directory and confirm all green before returning.
>
> **Before returning, commit your work to branch `story/<story_key>` using conventional-commit style (e.g. `feat(<story_short>): <one-line summary>`). Use a HEREDOC for the message. Do NOT push, do NOT open a PR, do NOT modify `sprint-status.yaml` or any other status/state file. Verify `git status` is clean and `git log --oneline origin/main..HEAD` shows your commit(s) before returning.**
>
> Do NOT pause for clarifying questions; make reasonable defaults and proceed. When done, return a one-paragraph summary including the commit SHA(s).

```bash
$SH set-status <story_key> in-progress     # at spawn
$SH set-status <story_key> review          # on return
$SH record <story_key> implemented
```

If the returned summary reports no commit (or `git -C <worktree_path> log --oneline origin/main..HEAD` is empty), do NOT proceed to Step 7 — re-spawn the dev subagent with "your previous run left no commits on the branch; commit your scaffold per the prompt above." Burning a review pass on an empty diff is the failure mode this guard exists for.

### Step 7 — Review ↔ rework cycle (subagent: bmad-code-review, max 3 passes)

Maintain a local counter `passes = 0`. Loop:

1. `passes += 1`. Halt with `REVIEW_BLOCKED` if `passes > 3`.
2. Spawn a fresh subagent: "Run `bmad-code-review` against the diff on branch `story/<story_key>`. Return verdict (`approve` / `request-changes` / `block`) and an itemised issue list. Do NOT modify `sprint-status.yaml`. Do NOT pause for questions."
3. `$SH record <story_key> review_pass --data '{"pass":N,"verdict":"..."}'`
4. If `approve` → break; continue to Step 8.
5. If `block` → halt with `REVIEW_BLOCKED`. No PR.
6. If `request-changes` → spawn a fresh dev subagent (running `bmad-dev-story`) with the issue list and `<spec_path>`: "Address each issue. Do not change scope beyond what was flagged. Commit your fixes to `story/<story_key>` before returning (do not push, do not touch sprint-status.yaml). Confirm tests still green." Then loop to step 1.

### Step 8 — Systematic AC verification (subagent: bmad-qa-generate-e2e-tests)

Spawn ONE fresh subagent. Prompt (with the AC list pasted verbatim from `/tmp/ship-<story_key>.resolve.json`):

> Story: `<story_key>`. Spec at `<spec_path>`. Acceptance criteria:
> <numbered AC list>
>
> Step 1 — Run the `bmad-qa-generate-e2e-tests` skill against the implemented code on branch `story/<story_key>`. Generate API/E2E tests that exhaustively cover every AC above. If an existing unit test already covers an AC, reuse it; do not duplicate.
>
> Step 2 — Run the full test suite (the QA-generated tests plus any pre-existing unit tests).
>
> Step 3 — Output a single JSON array to `/tmp/ship-<story_key>.acs.json` with objects of shape:
> `{"ac": "<verbatim AC>", "test": "<test name/path>", "result": "pass" | "fail", "evidence": "<short string: output snippet or file:line of assertion>"}`
> Exactly one row per AC, in original order. Then output the same JSON to stdout.
>
> Do NOT skip ACs. Do NOT mark an AC `pass` without a runnable test that asserts it. If you cannot make an AC green, mark it `fail` and explain in `evidence` — do not retry forever.
>
> **Before returning, commit any new or modified test files to `story/<story_key>` using a conventional-commit message (e.g. `test(<story_short>): add acceptance suite covering all ACs`). Use a HEREDOC. Do NOT push, do NOT open a PR, do NOT modify `sprint-status.yaml`. Verify `git status` is clean before returning.**
>
> Do NOT pause for clarifying questions.

Then gate:

```bash
$SH verify-ac-table /tmp/ship-<story_key>.acs.json
```

Non-zero exit → halt with `AC_VERIFICATION_FAILED`. No PR. Record:

```bash
$SH record <story_key> ac_verified
```

After recording, verify the worktree is clean (`git -C <worktree_path> status --porcelain` empty). If any QA-generated files are still uncommitted, halt with `AC_VERIFICATION_FAILED` and surface the unstaged paths — never paper over by committing them yourself.

### Step 9 — Open the PR

Build the body deterministically:

```bash
$SH pr-body /tmp/ship-<story_key>.resolve.json /tmp/ship-<story_key>.acs.json <passes> > /tmp/ship-<story_key>.body.md
```

From inside the worktree:

```bash
cd <worktree_path>
git push -u origin "story/<story_key>"
gh pr create \
  --title "feat(<epic_num>): <title>" \
  --body-file /tmp/ship-<story_key>.body.md
```

Capture the PR URL **and PR number** (extract from the URL — Step 10 needs `<pr_number>` for `gh pr checks`). Record:

```bash
$SH record <story_key> pr_opened --data '{"url":"...","number":N}'
```

Note: status stays at `review` — Jack gates the merge, not this skill.

### Step 10 — CI watch ↔ resolve cycle (max 3 passes)

Mirrors Step 7's review/rework structure. Maintain a local counter `ci_passes = 0`. Loop:

1. `ci_passes += 1`. Halt with `CI_BLOCKED` if `ci_passes > 3`.
2. Wait for CI to settle on the PR (poll every 60s, cap 15min). The cheap check:
   ```bash
   gh pr checks <pr_number> --watch
   ```
   If the command itself exits non-zero because checks are still queued/running past the cap, halt with `CI_TIMEOUT` (not `CI_BLOCKED` — Jack can resume manually).
3. `$SH record <story_key> ci_pass --data '{"pass":N,"conclusion":"success|failure|timeout"}'`
4. If all required checks are `success` → break; continue to Step 11.
5. If any required check is `failure`:
   - Pull failing-job logs: `gh run view <run_id> --log-failed` for each failing run.
   - Spawn a fresh dev subagent (running `bmad-dev-story`) with: the failing-check names, the captured logs, the spec path, and the worktree path. Prompt:
     > CI failed on PR #<pr_number> for branch `story/<story_key>` (worktree `<worktree_path>`). Failures: <list>. Logs: <paste>. Diagnose the root cause, fix it inside the worktree, and re-run `pnpm install && pnpm build && pnpm test` locally to confirm green. **Before returning, commit your fix to `story/<story_key>` with a conventional-commit message (e.g. `fix(<story_short>): <one-line>`) and push to origin so CI re-runs. Do NOT modify `sprint-status.yaml`. Do NOT widen scope beyond what the failing checks demanded. Do NOT pause for clarifying questions.**
   - Then loop to step 1.

When CI is green, record:

```bash
$SH record <story_key> ci_green
```

### Step 11 — Summarise

Tell the user, in 2-3 sentences:
- which story shipped + PR URL
- review passes consumed (`N of 3`) and CI passes consumed (`M of 3`)
- where the run log lives (for replay/debug)

## Halt taxonomy

The skill halts (no PR) on any of these. Each is recorded in the run log before exit:

| Code | Meaning | Suggested next step |
|------|---------|---------------------|
| `PREFLIGHT_FAIL` | Step 1 caught dirty tree / unauthed gh / missing files | Address what stderr listed |
| `NO_ELIGIBLE_STORY` | No backlog stories remain or arg matched nothing | Check sprint-status.yaml |
| `MISSING_ACS` | Story has no Acceptance Criteria section | Author the epic before shipping |
| `WORKTREE_CONFLICT` | Path or branch already exists | Clean up old run before retry |
| `SPEC_VALIDATION_FAILED` | Step 5 caught spec issues before any code burned | Re-run `bmad-create-story` and re-author, then retry |
| `REVIEW_BLOCKED` | Reviewer said `block` or 3 passes elapsed without `approve` | Jack decides: iterate manually or `/bmad-correct-course` |
| `AC_VERIFICATION_FAILED` | One or more ACs not green, or QA left uncommitted files | Fix the failing AC's code/test (or commit the QA artefact); rerun from Step 8 |
| `CI_BLOCKED` | 3 CI-fix passes elapsed and required checks still failing | Jack decides: iterate manually on the PR, or `/bmad-correct-course` |
| `CI_TIMEOUT` | CI didn't settle within 15min poll cap | Re-run Step 10 once checks complete |

## Resume after halt

```bash
$SH state <story_key>
```

Returns the JSONL event history. The latest event tells you which step succeeded last — pick up at the next one. (Full automatic resume is out of scope for v1; this surface is for Jack and the orchestrator to decide what to do.)

## Why scripts and not pure prose

- **Deterministic plumbing**: story picking, AC extraction, status mutation, AC-table gating, and PR-body templating must be byte-identical run to run. Subagents shouldn't reinvent them.
- **Auditable**: every milestone is JSONL — easy to grep, replay, post-mortem.
- **Cheap to evolve**: change AC heading conventions? Update one regex in `ship.py`, not every orchestrator prompt.
- **Fail closed**: invalid status transitions, missing ACs, unauthed gh, and malformed specs all fail at the script or VS layer before tokens burn.
