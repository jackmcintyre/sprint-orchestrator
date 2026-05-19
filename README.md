# crew

crew is an experiment in replacing the product engineering team with AI tooling. The product being built here is **AI Engineering Team v1** — a Claude Code plugin that lets a non-engineer drive a project-shaped team of long-lived AI agents through a continuous-flow backlog.

## Status

Active build. Epic 1 (plugin foundation) is in progress; the plugin is installable but not yet runnable end-to-end. See `plugins/crew/docs/README-install.md` for the install checkpoints available today.

## Install

See [`plugins/crew/docs/README-install.md`](plugins/crew/docs/README-install.md).

## Repository layout

```
plugins/crew/                  — the plugin (MCP server, skills, adapters)
plugins/crew/docs/             — install walkthrough, standards template
_bmad-output/                  — planning artifacts (PRD, epics, stories) — gitignored
```

## License

MIT
