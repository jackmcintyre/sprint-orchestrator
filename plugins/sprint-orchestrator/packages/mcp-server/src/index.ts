import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { defaultContext, type ToolContext } from "./tools/context.js";
import { getSprintStatus } from "./tools/get-sprint-status.js";
import { getSprintReport } from "./tools/get-sprint-report.js";
import { getReadyStories } from "./tools/get-ready-stories.js";
import { getStoryContext } from "./tools/get-story-context.js";
import { claimStory } from "./tools/claim-story.js";
import { markStoryComplete } from "./tools/mark-story-complete.js";
import { markStoryFailed } from "./tools/mark-story-failed.js";
import { markStoryNeedsRework } from "./tools/mark-story-needs-rework.js";
import { validateAcceptanceCriteria } from "./tools/validate-acceptance-criteria.js";
import { releaseStaleClaims } from "./tools/release-stale-claims.js";
import { getOrInitConfig } from "./tools/get-or-init-config.js";
import { commitStoryArtefacts } from "./tools/commit-story-artefacts.js";
import { lintSprint } from "./tools/lint-sprint.js";
import { prepareStoryBranch } from "./tools/prepare-story-branch.js";
import { recordStoryReopen } from "./tools/record-story-reopen.js";
import { resolveSpawnModel } from "./tools/resolve-spawn-model.js";
import { setConfigPrPerStory } from "./tools/set-config-pr-per-story.js";
import { markDevReturned } from "./tools/mark-dev-returned.js";

export const PLUGIN_NAME = "sprint-orchestrator";

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

export function buildServer(ctx: ToolContext = defaultContext()): McpServer {
  const server = new McpServer({ name: PLUGIN_NAME, version: "0.0.1" });

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Smoke-test tool. Echoes back the message you send.",
      inputSchema: { message: z.string().default("pong") },
    },
    async ({ message }) => ({
      content: [{ type: "text", text: `pong: ${message}` }],
    }),
  );

  server.registerTool(
    "getOrInitConfig",
    {
      title: "Get or init config",
      description:
        "Returns the orchestrator config. Auto-detects BMAD v6 layout. If no layout is recognised, returns needsSetup with prompts the agent should ask the user.",
      inputSchema: {},
    },
    async () => json(await getOrInitConfig(ctx)),
  );

  server.registerTool(
    "getSprintStatus",
    {
      title: "Get sprint status",
      description: "Read the full sprint-status.yaml file.",
      inputSchema: {},
    },
    async () => json(await getSprintStatus(ctx)),
  );

  server.registerTool(
    "getSprintReport",
    {
      title: "Get sprint report",
      description:
        "Read-only sprint summary: per-status counts, a per-story summary array, and a rendered multi-line string suitable for chat display. Does not mutate state.",
      inputSchema: {},
    },
    async () => json(await getSprintReport(ctx)),
  );

  server.registerTool(
    "getReadyStories",
    {
      title: "Get ready stories",
      description:
        "Returns stories with status=ready whose dependencies are all done. Stable order.",
      inputSchema: {},
    },
    async () => json(await getReadyStories(ctx)),
  );

  server.registerTool(
    "getStoryContext",
    {
      title: "Get story context",
      description:
        "Returns the story plus absolute paths to PRD / architecture / story files (per config). The dev agent reads what it needs from those paths.",
      inputSchema: { storyId: z.string() },
    },
    async ({ storyId }) => json(await getStoryContext(ctx, storyId)),
  );

  server.registerTool(
    "claimStory",
    {
      title: "Claim story",
      description:
        "Atomically claim a ready story for an agent. Returns { claimed: true } or { claimed: false, holder } when another agent already has it.",
      inputSchema: { storyId: z.string(), agentId: z.string() },
    },
    async ({ storyId, agentId }) => json(await claimStory(ctx, storyId, agentId)),
  );

  server.registerTool(
    "prepareStoryBranch",
    {
      title: "Prepare per-story branch",
      description:
        "Create and check out a `<story-id>-<slug>` branch from `default_base` so the dev subagent's commits land on a per-story branch. No-ops (returns { branch: null, skipped: true }) when `pr_per_story` is false. Persists the branch on `story.orchestrator.branch` for downstream tooling. Local-only — never touches origin or gh.",
      inputSchema: { storyId: z.string(), agentId: z.string() },
    },
    async ({ storyId, agentId }) => json(await prepareStoryBranch(ctx, storyId, agentId)),
  );

  server.registerTool(
    "markDevReturned",
    {
      title: "Mark dev returned",
      description:
        "Persist orchestrator.dev_returned_at for a story. The dev subagent calls this immediately before returning its summary. recordStoryFailure and validateAcceptanceCriteria refuse when this timestamp is absent, preventing spurious reviewer failures before any dev work has happened.",
      inputSchema: { storyId: z.string(), agentId: z.string() },
    },
    async ({ storyId, agentId }) => json(await markDevReturned(ctx, storyId, agentId)),
  );

  server.registerTool(
    "recordStorySuccess",
    {
      title: "Record story success",
      description:
        "Record a successful completion for a claimed story. State-machine transition only — re-runs acceptance criteria inside the lock; rejects if the caller is not the claim holder or AC fails. Renamed from markStoryComplete to avoid harness classifier conflicts on the literal token 'done'.",
      inputSchema: {
        storyId: z.string(),
        agentId: z.string(),
        summary: z.string(),
        artefacts: z.array(z.string()).default([]),
      },
    },
    async ({ storyId, agentId, summary, artefacts }) => {
      const result = await markStoryComplete(ctx, storyId, agentId, summary, artefacts);
      return json({ ok: true, ...result });
    },
  );

  server.registerTool(
    "recordStoryFailure",
    {
      title: "Record story failure",
      description:
        "Record a failure for a story with a structured reason. State-machine transition only. No silent retries. Renamed from markStoryFailed for classifier-safety.",
      inputSchema: {
        storyId: z.string(),
        reason: z.string(),
        failure_details: z
          .array(
            z.object({
              cmd: z.string(),
              exit_code: z.number().int(),
              expected_exit: z.number().int(),
              stderr: z.string(),
              stdout: z.string(),
              recorded_at: z.string(),
            }),
          )
          .optional(),
      },
    },
    async ({ storyId, reason, failure_details }) => {
      const result = await markStoryFailed(ctx, storyId, reason, failure_details);
      return json({ ok: true, ...result });
    },
  );

  server.registerTool(
    "recordStoryRework",
    {
      title: "Record story rework",
      description:
        "Record a failed-review attempt on a claimed in-progress story. State-machine transition only — increments rework_count, stores reviewer feedback, and reports whether the cap has been reached. Does not change status or release the claim — the same dev gets another swing. Renamed from markStoryNeedsRework for classifier-safety.",
      inputSchema: {
        storyId: z.string(),
        agentId: z.string(),
        reason: z.string().min(1),
        reworkLimit: z.number().int().positive().optional(),
      },
    },
    async ({ storyId, agentId, reason, reworkLimit }) => {
      const result = await markStoryNeedsRework(ctx, storyId, agentId, reason, reworkLimit);
      return json({ ok: true, ...result });
    },
  );

  server.registerTool(
    "recordStoryReopen",
    {
      title: "Record story reopen",
      description:
        "Transition a failed story back to ready so the orchestrator picks it up again. Clears failed_at, last_failure_reason, claimed_by, claimed_at. Preserves rework_count for audit. Appends an entry to orchestrator.reopen_history. Refuses if status != failed. For human (or future supervisor agent) recovery — the automated reviewer never calls this.",
      inputSchema: { storyId: z.string(), reason: z.string().min(1) },
    },
    async ({ storyId, reason }) => {
      const result = await recordStoryReopen(ctx, storyId, reason);
      return json({ ok: true, ...result });
    },
  );

  server.registerTool(
    "validateAcceptanceCriteria",
    {
      title: "Validate acceptance criteria",
      description: "Run all acceptance checks defined on the story. Read-only.",
      inputSchema: { storyId: z.string() },
    },
    async ({ storyId }) => json(await validateAcceptanceCriteria(ctx, storyId)),
  );

  server.registerTool(
    "commitStoryArtefacts",
    {
      title: "Commit story artefacts",
      description:
        "Stage and commit the working tree as the result of one story. Message format: feat(<storyId>): <title>, with a Co-authored-by: Claude trailer. Returns { sha } or { sha: null } when there is nothing to commit.",
      inputSchema: { storyId: z.string() },
    },
    async ({ storyId }) => json(await commitStoryArtefacts(ctx, storyId)),
  );

  server.registerTool(
    "lintSprint",
    {
      title: "Lint sprint acceptance criteria",
      description:
        "Read-only lint pass over sprint-status.yaml. Flags state-mutator stories (touching mark-story-*.ts, commit-story-artefacts.ts, get-ready-stories.ts, schema.ts, etc.) that lack an integration AC, shell checks with known-bad patterns (e.g. vitest --grep), and trivially-satisfiable regex checks. Returns { issues, rendered }.",
      inputSchema: { sprintStatusPath: z.string().optional() },
    },
    async ({ sprintStatusPath }) => json(await lintSprint(ctx, { sprintStatusPath })),
  );

  server.registerTool(
    "resolveSpawnModel",
    {
      title: "Resolve spawn model",
      description:
        "Return the model ID the orchestrator should pass to Task when spawning a `dev` or `reviewer` subagent for a story. Resolution order: config.models[role], then the agent file's `model:` frontmatter, then the DEFAULT_*_MODEL fallback. Story 1 of model-tiering-v1 — no escalation logic yet.",
      inputSchema: {
        storyId: z.string(),
        role: z.enum(["dev", "reviewer"]),
      },
    },
    async ({ storyId, role }) => json(await resolveSpawnModel(ctx, { storyId, role })),
  );

  server.registerTool(
    "setConfigPrPerStory",
    {
      title: "Set config pr_per_story",
      description:
        "Persist the user's pr_per_story preference (true = open a branch + PR per story; false = commit directly to the working branch) to `.sprint-orchestrator/config.yaml`. Refuses if no config file exists yet — the user must complete layout setup via `getOrInitConfig` first.",
      inputSchema: { value: z.boolean() },
    },
    async ({ value }) => json(await setConfigPrPerStory(ctx, value)),
  );

  server.registerTool(
    "releaseStaleClaims",
    {
      title: "Release stale claims",
      description:
        "Reset to ready any in-progress story whose claim is older than the threshold (minutes). For crashed-agent recovery.",
      inputSchema: { olderThanMinutes: z.number().positive() },
    },
    async ({ olderThanMinutes }) => json(await releaseStaleClaims(ctx, olderThanMinutes)),
  );

  return server;
}

export async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
