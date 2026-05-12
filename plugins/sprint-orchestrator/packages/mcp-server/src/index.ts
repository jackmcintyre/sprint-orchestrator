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
    "markStoryComplete",
    {
      title: "Mark story complete",
      description:
        "Mark a claimed story done. Re-runs acceptance criteria inside the lock; rejects if the caller is not the claim holder or AC fails.",
      inputSchema: {
        storyId: z.string(),
        agentId: z.string(),
        summary: z.string(),
        artefacts: z.array(z.string()).default([]),
      },
    },
    async ({ storyId, agentId, summary, artefacts }) => {
      await markStoryComplete(ctx, storyId, agentId, summary, artefacts);
      return json({ ok: true });
    },
  );

  server.registerTool(
    "markStoryFailed",
    {
      title: "Mark story failed",
      description: "Mark a story as blocked with a structured reason. No silent retries.",
      inputSchema: { storyId: z.string(), reason: z.string() },
    },
    async ({ storyId, reason }) => {
      await markStoryFailed(ctx, storyId, reason);
      return json({ ok: true });
    },
  );

  server.registerTool(
    "markStoryNeedsRework",
    {
      title: "Mark story needs rework",
      description:
        "Record a failed-review attempt on a claimed in-progress story. Increments rework_count, stores reviewer feedback, and reports whether the cap has been reached. Does not change status or release the claim — the same dev gets another swing.",
      inputSchema: {
        storyId: z.string(),
        agentId: z.string(),
        reason: z.string().min(1),
        reworkLimit: z.number().int().positive().optional(),
      },
    },
    async ({ storyId, agentId, reason, reworkLimit }) =>
      json(await markStoryNeedsRework(ctx, storyId, agentId, reason, reworkLimit)),
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
