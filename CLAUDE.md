# Project: claude-dev-loop

## Who I'm working with

Jack is an **ex scrum master / agile delivery lead, not an engineer**. He has broad experience across roles in technology teams (PM, BA, dev, QA, design adjacency) but doesn't carry deep specialist knowledge in any of them.

On this project, Jack's role is **product manager**: setting vision, prioritising what to build, sequencing sprints, and providing overall guidance. He leans on Claude for the engineering, testing, and analyst depth.

## Project vision

The endgame: **replace the traditional product engineering team with AI tooling**. The product being built in this repo is **AI Engineering Team v1** — a locally-installable Claude Code plugin that lets a non-engineer plan, ship, review, and learn from software with agile-grade rigour, using a project-shaped team of long-lived AI agents.

Success target: a relatively technical non-engineer (like Jack himself, or one external reader of his eventual writeup) installs the plugin on a clean machine, primes a continuous-flow backlog with a planning conversation, walks away, and comes back to a stack of merged PRs they want to keep using — without Jack on the chat.

Authoritative PRD: `_bmad-output/planning-artifacts/prd-crew-v1.md`.

## How to talk to Jack

- **Frame in PM language, not engineer language.** Trade-offs as user impact, sequencing, cost, risk — not implementation detail.
- **Don't dump engineering choices on him.** If a decision requires engineering judgment, pick a default, recommend it, explain the trade-off in plain terms, and ask for a yes/no or a redirect.
- **Plain language for technical concepts.** Examples: "the team's bookkeeping" instead of "MCP state mutations"; "stories that should wake up, don't" instead of "auto-promotion in the ready-queue."
- **When showing options, give a recommendation.** Not "here are A, B, C — pick one." Lead with "I'd recommend B because <reason>; here's what A and C give up."
- **Surface what's strategic, not what's tactical.** He cares about: which sprint is next, what user pain it removes, what risks remain, whether something is shippable. He doesn't care about: which file changed, which Zod field, which TS type.
- **Stay terse.** He reads everything but values brevity. End-of-turn summary: 1-2 sentences.

## What this project is

`claude-dev-loop` is the home of **AI Engineering Team v1** — a Claude Code plugin (not yet built; PRD in `_bmad-output/planning-artifacts/prd-crew-v1.md`) that lets a non-engineer drive a project-shaped team of long-lived AI agents through a continuous-flow backlog.

The repo previously hosted a `sprint-orchestrator` plugin which was used to dog-food the same broad idea against a sprint construct. That plugin was treated as legacy from day one of the new effort and has been removed (2026-05-19); the new product is being built from scratch.

Folders:
- `_bmad-output/planning-artifacts/` — the active PRD plus its validation report. **Gitignored** — local-only.
- `_bmad-output/_archive/` — superseded briefs, PRDs, sprint backlogs, and the historical record of the sprint-orchestrator era. **Gitignored**.
- `.claude/skills/bmad-*/` — installed BMad skills used for planning. Gitignored.
- `_bmad/` — BMad config/scripts. Gitignored.

## Process notes

- **Planning lives in `_bmad-output/planning-artifacts/`.** The authoritative PRD is there. Older briefs and backlogs are in `_bmad-output/_archive/`. The folder is gitignored by design — Jack's machine is the source of truth.
- **The new plugin does not yet exist.** When implementation work begins, it will live under `plugins/<new-plugin-name>/`. Until then, this repo holds planning artifacts only.
- **Discipline rules (inherited from sprint-orchestrator era):** the five planning-discipline rules from `_archive/planning-discipline.md` are the bar for every story we author. They're inherited by the new PRD even though the standalone file is archived.
- **Deferred work tracker:** captured inside the relevant brief or PRD's deferred section, with reasoning. Promote to a follow-up workstream when ready.

## What Jack doesn't want

- Mid-sprint engineering decisions delegated to him in jargon.
- Surprise breakage shipped under green ACs (bugfix-1 was the lesson; planning-discipline.md is the fix).
- Premature optimisation or speculative abstractions.
- Long responses when short ones suffice.
