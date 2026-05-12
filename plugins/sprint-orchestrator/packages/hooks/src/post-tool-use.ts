import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readStdinJson } from "./lib/io.js";

// Resolve prettier from the plugin's own node_modules so the hook works in
// projects that don't depend on prettier themselves.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRETTIER_BIN = path.resolve(HERE, "..", "node_modules", ".bin", "prettier");

export interface PostToolUseInput {
  cwd?: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    path?: string;
    command?: string;
    storyId?: string;
    story_id?: string;
    agentId?: string;
    summary?: string;
    reason?: string;
    feedback?: string;
  };
  tool_response?: { exit_code?: number; stdout?: string; stderr?: string };
}

export const FORMATTABLE = /\.(tsx?|jsx?|mjs|cjs)$/i;
export const TEST_CMD_HINT = /\b(pnpm|npm|yarn)\s+(-\w+\s+)*(test|vitest|jest)\b/;

/** MCP tool-name suffix that signals a story is being claimed (story_start). */
export const STORY_START_TOOLS = new Set(["claimStory"]);
/** MCP tool-name suffixes that signal a story is leaving the active set (story_end). */
export const STORY_END_TOOLS = new Set([
  "markStoryComplete",
  "markStoryFailed",
  "markStoryNeedsRework",
]);

/**
 * Extract the trailing tool name from an MCP tool identifier like
 * `mcp__sprint-orchestrator__claimStory`. Returns `null` for non-MCP tools.
 */
export function mcpToolSuffix(toolName: string | undefined): string | null {
  if (!toolName || !toolName.startsWith("mcp__")) return null;
  const parts = toolName.split("__");
  return parts.length >= 3 ? parts[parts.length - 1]! : null;
}

export async function handlePostToolUse(input: PostToolUseInput | null): Promise<void> {
  if (!input) return;
  const projectRoot = input.cwd ?? process.cwd();

  if (
    input.tool_name === "Write" ||
    input.tool_name === "Edit" ||
    input.tool_name === "MultiEdit"
  ) {
    const target = input.tool_input?.file_path ?? input.tool_input?.path;
    if (target && FORMATTABLE.test(target)) {
      await formatFile(projectRoot, target);
    }
  }

  if (input.tool_name === "Bash") {
    const cmd = input.tool_input?.command ?? "";
    if (TEST_CMD_HINT.test(cmd)) {
      await appendRunLog(projectRoot, {
        event: "test_run",
        at: new Date().toISOString(),
        command: cmd,
        exit_code: input.tool_response?.exit_code ?? null,
      });
    }
  }

  const suffix = mcpToolSuffix(input.tool_name);
  if (suffix) {
    const storyId = input.tool_input?.storyId ?? input.tool_input?.story_id;
    if (STORY_START_TOOLS.has(suffix) && storyId) {
      await appendRunLog(projectRoot, {
        event: "story_start",
        at: new Date().toISOString(),
        story_id: storyId,
        tool: suffix,
        agent_id: input.tool_input?.agentId ?? null,
      });
    } else if (STORY_END_TOOLS.has(suffix) && storyId) {
      const outcome =
        suffix === "markStoryComplete"
          ? "complete"
          : suffix === "markStoryFailed"
            ? "failed"
            : "needs_rework";
      await appendRunLog(projectRoot, {
        event: "story_end",
        at: new Date().toISOString(),
        story_id: storyId,
        tool: suffix,
        outcome,
      });
    }
  }
}

export async function formatFile(projectRoot: string, target: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(PRETTIER_BIN, ["--write", "--no-error-on-unmatched-pattern", target], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

export async function appendRunLog(
  projectRoot: string,
  entry: Record<string, unknown>,
): Promise<void> {
  const dir = path.join(projectRoot, ".sprint-orchestrator");
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, "run.log"), `${JSON.stringify(entry)}\n`, "utf8");
}

const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  readStdinJson<PostToolUseInput>()
    .then(handlePostToolUse)
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[post-tool-use]", err);
    });
}
