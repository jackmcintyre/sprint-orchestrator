# User-surface ACs and the pre-PR smoke gate

This is the authoring-facing reference for the `user-surface` AC tag and the
pre-PR smoke gate in `ship-story`. The ship-story orchestrator injects a
summary of these rules into every `bmad-create-story` subagent prompt; this
doc is the spec they cite.

## Why this exists

Document-driven verification has a known blind spot: every gate in `ship-story`
reasons from artefacts (epic, spec, diff, AC table) — none of them is the
end user. Stories 1.7 and 1.7a each shipped under 4/4 green ACs and approved
code review; both contained user-facing surfaces (a slash command, an install
path) that no agent ever actually ran against real Claude Code. Eight bugs
surfaced the moment Jack tried the install live.

The fix is structural: ACs that name a user-invocable surface are tagged
`(user-surface)`, and the pre-PR gate refuses to open a PR until evidence
exists that the surface was actually exercised — either by an automated
harness that drives it, or by an operator pasting verbatim Claude Code
output.

## What counts as a user-surface

An AC is `user-surface` if and only if it references at least one of:

- **(i) a slash command literal** (e.g. `/crew:status`, `/ship-story`)
- **(ii) a CLI command the operator types verbatim** (e.g. `pnpm install`,
  `git clone`, `python3 scripts/foo.py`)
- **(iii) a file path the README/install docs instruct the user to copy or
  open by name** (e.g. "copy `plugins/crew/.claude-plugin/plugin.json` to
  …")
- **(iv) any Claude Code UI element the user is expected to observe**
  (TUI panel, toast, tab-complete, slash-command picker entry)

ACs that name only internal functions, schemas, MCP tools, or implementation
files are **NOT** `user-surface`.

## Tag convention

In the story-spec Markdown, every AC item is one of:

```
**AC1 (user-surface):**
**Given** ...
```

or

```
**AC1:**
**Given** ...
```

The numeric prefix (`AC1`, `AC2`, …) is canonical; the parenthetical tag
immediately after the AC number is either `(user-surface)` or absent. The
gate ignores all other parentheticals (e.g. `(integration)`). No other tag
values trigger gate behaviour in this version of the gate.

## Tag-extraction regex

The gate parses tagged ACs out of the spec using:

```python
USER_SURFACE_AC_RE = re.compile(
    r"^\*\*AC(\d+)\s*\(user-surface\)\s*:\*\*",
    re.MULTILINE,
)
```

For each match, `int(match.group(1))` is the AC index. The full set is the
gate's coverage requirement.

## Examples

User-surface (tag required):

```
**AC1 (user-surface):**
**Given** the operator has installed the crew plugin,
**When** they run `/crew:status` in a fresh Claude Code session,
**Then** the tab-complete picker lists the command and invoking it prints
the plugin version.
```

```
**AC2 (user-surface):**
**Given** the README install steps,
**When** the operator copies `plugins/crew/.claude-plugin/plugin.json` per
the docs and reloads Claude Code,
**Then** the plugin appears in the active plugin list.
```

Not user-surface (no tag):

```
**AC3:**
**Given** a malformed `user_surface_verified` event,
**When** `ship.py pre-pr-gate` reads the run log,
**Then** the gate exits 42 and prints `MalformedVerificationEvent`.
```

(AC3 names only internal Python paths and exit codes; the operator never
types or observes any of them directly.)

## How the gate uses this

`ship.py pre-pr-gate <story_key>` runs between `verify-ac-table` and
`gh pr create`. It:

1. Parses the story spec and extracts the set of `(user-surface)` AC indexes.
2. If the set is empty → exits 0 with `{"status":"skipped"}`. Proceed.
3. Otherwise reads the run log JSONL and looks for valid verification events
   covering every user-surface AC. Two event types satisfy the gate:
   - `automated_e2e_verified` — an automated test drives the surface.
   - `user_surface_verified` — the operator pasted verbatim Claude Code
     output.
4. If the union of valid events covers every user-surface AC → exits 0 with
   `{"status":"passed","route":"automated|operator|mixed"}`.
5. Otherwise → exits `42` (`USER_SURFACE_UNVERIFIED`) and refuses the PR.

Malformed verification events (missing `ac_refs`, missing `pasted_output`,
etc.) never count toward coverage and trigger a `MalformedVerificationEvent:`
diagnostic on stderr.
