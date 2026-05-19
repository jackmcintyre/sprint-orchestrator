# crew

crew is an experiment in replacing the product engineering team with AI tooling.
The piece that turned out useful is the **sprint-orchestrator** plugin — it drives a sprint
backlog end-to-end via dev and reviewer subagents, so a planned sprint becomes a stack of
shipped, reviewed PRs while you walk away. The goal: a relatively technical non-engineer can
build software with the rigour that agile/scrum traditionally enforced, but with AI tooling
replacing hands-on-keyboards.

## Run your first example sprint in 5 minutes

**Prerequisites:**

- [Node.js](https://nodejs.org/) 20 or later
- [pnpm](https://pnpm.io/installation) 9 or later (`npm install -g pnpm`)
- [Claude Code](https://claude.ai/code) installed and running

**1. Install the plugin**

```bash
git clone https://github.com/jackmcintyre/crew.git
cd crew
pnpm --dir plugins/sprint-orchestrator install
```

Then inside Claude Code, from the repo root:

```
/plugin install plugins/sprint-orchestrator
```

> **After installing**, restart Claude Code so the new MCP tools register correctly.
> `/reload-plugins` alone is not enough — a full restart is required.

**2. Run the bundled example sprint**

```
/sprint-orchestrator:run-sprint
```

Run that from the `examples/hello-sprint/` directory (or open it as your project root).
The orchestrator will drive the pre-written example backlog through dev and review, printing
a summary when it finishes.

See [`examples/hello-sprint/`](./examples/hello-sprint/) for the full example setup —
including the example `sprint-status.yaml` you can use as a template for your own backlog.

## Use it on your own project

Read the plugin docs for `adapt-bmad`, configuration options, cost transparency, and
architecture details:

[`plugins/sprint-orchestrator/README.md`](./plugins/sprint-orchestrator/README.md)

## Repository layout

```
plugins/sprint-orchestrator/   — the plugin (MCP server, skills, agents)
examples/hello-sprint/         — a runnable example sprint
```

## License

MIT
