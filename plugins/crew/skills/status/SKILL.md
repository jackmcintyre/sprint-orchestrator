---
name: crew:status
description: Print the current plugin version, target repo, adapter, and standards-doc state.
allowed_tools: [Read]
---

# /crew:status

# What this skill does

Calls the `getStatus` MCP tool and prints a five-line status block confirming that the plugin sees your repo: plugin version, resolved target-repo path, active adapter (and whether its config still matches the repo), standards-doc state, and the current cycle (always `none` in v1).

# Prerequisites

A target repo with `.crew/config.yaml` resolved (auto-detected on first run by the workspace resolver — see `docs/README-install.md` checkpoint 5).

# Steps

1. Invoke the `getStatus` MCP tool with `targetRepoRoot` set to the current workspace root.
2. Print the tool's text response verbatim (it is already the five-line status block).

# Failure modes

- **No `.crew/config.yaml` and no adapter matches:** the tool throws `NoAdapterMatchedError`. The skill surfaces the error message verbatim — it already tells the user to either init a planning tool the plugin understands or follow `docs/README-install.md` step 5.
- **`.crew/config.yaml` exists but the listed adapter no longer matches the repo:** the status line shows `adapter: <name> (mismatched)` and lists any other matching adapters the user can switch to. No exception is thrown — the report itself carries the downgrade.
- **`docs/standards.md` missing or malformed:** the `standards:` line shows `missing` or `malformed` (with the absolute path). Run `cp plugins/crew/docs/standards-example.md <target-repo>/docs/standards.md` to fix (README-install.md checkpoint 5).
