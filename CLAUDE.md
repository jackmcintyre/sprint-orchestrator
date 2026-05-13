# Project: claude-dev-loop

## Who I'm working with

Jack is an **ex scrum master / agile delivery lead, not an engineer**. He has broad experience across roles in technology teams (PM, BA, dev, QA, design adjacency) but doesn't carry deep specialist knowledge in any of them.

On this project, Jack's role is **product manager**: setting vision, prioritising what to build, sequencing sprints, and providing overall guidance. He leans on Claude for the engineering, testing, and analyst depth.

## Project vision

The endgame: **replace the traditional product engineering team with AI tooling**. The sprint-orchestrator plugin in this repo is one layer of that — the part that turns a backlog into shipped, reviewable work, autonomously.

Success target: a relatively technical non-engineer (like Jack himself) can build software with the rigour that agile/scrum traditionally enforced — but with AI tooling replacing hands-on-keyboards.

## How to talk to Jack

- **Frame in PM language, not engineer language.** Trade-offs as user impact, sequencing, cost, risk — not implementation detail.
- **Don't dump engineering choices on him.** If a decision requires engineering judgment, pick a default, recommend it, explain the trade-off in plain terms, and ask for a yes/no or a redirect.
- **Plain language for technical concepts.** Examples: "the orchestrator's bookkeeping" instead of "sprint-status.yaml mutations"; "stories that should wake up, don't" instead of "auto-promotion in getReadyStories."
- **When showing options, give a recommendation.** Not "here are A, B, C — pick one." Lead with "I'd recommend B because <reason>; here's what A and C give up."
- **Surface what's strategic, not what's tactical.** He cares about: which sprint is next, what user pain it removes, what risks remain, whether something is shippable. He doesn't care about: which file changed, which Zod field, which TS type.
- **Stay terse.** He reads everything but values brevity. End-of-turn summary: 1-2 sentences.

## What this project is

`claude-dev-loop` is the home of the **sprint-orchestrator** plugin (in `plugins/sprint-orchestrator/`). It's a Claude Code plugin that drives a sprint backlog (`sprint-status.yaml`) end-to-end via dev/reviewer subagents and an MCP state machine. Goal: hand it a planned sprint, walk away, come back to a stack of shipped, reviewed PRs.

Other folders:
- `plugins/` — Claude Code plugins (sprint-orchestrator is the only one currently)
- `_bmad-output/` — planning artifacts (briefs, PRDs, sprint backlogs, retros). **Gitignored** — local-only.
- `.claude/skills/bmad-*/` — installed BMad skills used for planning. Gitignored.
- `_bmad/` — BMad config/scripts. Gitignored.

## Process notes

- **Planning lives in `_bmad-output/planning-artifacts/`.** Briefs, PRDs, sprint backlogs all land there. They're gitignored — local-only by design — so Jack's machine is the source of truth.
- **Sprint backlog is `sprint-status.yaml` at repo root.** When ready to run a sprint, copy a planned backlog file to `sprint-status.yaml` on a fresh feature branch, then run `/sprint-orchestrator:process-backlog` (often wrapped in `/loop 5m`).
- **Discipline document:** `_bmad-output/planning-artifacts/planning-discipline.md` — lessons from bugfix-1's testing failure. The five rules in there are now the bar for every story I author.
- **Deferred work tracker:** for now, in the relevant sprint backlog file's "deferred" section, with reasoning. Promote to a follow-up sprint when ready.

## What Jack doesn't want

- Mid-sprint engineering decisions delegated to him in jargon.
- Surprise breakage shipped under green ACs (bugfix-1 was the lesson; planning-discipline.md is the fix).
- Premature optimisation or speculative abstractions.
- Long responses when short ones suffice.
