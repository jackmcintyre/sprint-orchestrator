# hello-sprint — quickstart example

The smallest possible sprint to prove the sprint-orchestrator loop works end-to-end.
Two stories, one trivial implementation, one ship gate. Should complete in under 5 minutes.

## What this is

Story 1 asks the dev subagent to create `HELLO.md` containing the line
`hello from sprint-orchestrator`. Story 2 is a ship gate that verifies the file exists
and contains that line — no code required, just confirmation that story 1 landed.

## How to run it

1. Open a new Claude Code context window with your working directory set to
   `examples/hello-sprint/` inside a repo that has the sprint-orchestrator plugin installed.
2. Run the skill:

   ```
   /sprint-orchestrator:run-sprint
   ```

3. Copy the printed `/goal` line and paste it as your next message. The orchestrator
   will drive both stories through dev and reviewer subagents automatically.

## What success looks like

- Both stories show `status: done` in `sprint-status.yaml`.
- `HELLO.md` exists inside `examples/hello-sprint/` and contains the line
  `hello from sprint-orchestrator`.

## What to try next

Once you have seen the loop work, head to the repo-root README for guidance on
running the orchestrator against your own project backlog.
