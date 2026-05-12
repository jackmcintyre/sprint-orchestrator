import { promises as fs } from "node:fs";
import * as path from "node:path";
import { readStdinJson, writeJson } from "./lib/io.js";
import { decideBash, decideUrl, decideWrite, type ToolDecision } from "./lib/deny-patterns.js";

export interface PreToolUseInput {
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown> & {
    command?: string;
    file_path?: string;
    path?: string;
    url?: string;
  };
}

export interface DenyOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

/**
 * Pure entry-point for tests and the CLI wrapper. Returns the JSON object to
 * emit, or null when the host should default to allow.
 */
export async function handlePreToolUse(input: PreToolUseInput | null): Promise<DenyOutput | null> {
  if (!input || !input.tool_name) return null;
  const projectRoot = input.cwd ?? process.cwd();
  const allowedDomains = await loadAllowedDomains(projectRoot);
  const decision = await evaluate(input, { projectRoot, allowedDomains });
  if (decision.allow) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason,
    },
  };
}

export async function evaluate(
  input: PreToolUseInput,
  ctx: { projectRoot: string; allowedDomains: string[] },
): Promise<ToolDecision> {
  const { tool_name, tool_input } = input;
  if (!tool_input) return { allow: true };

  switch (tool_name) {
    case "Bash": {
      const cmd = typeof tool_input.command === "string" ? tool_input.command : "";
      return decideBash(cmd);
    }
    case "Write":
    case "Edit":
    case "MultiEdit": {
      const target =
        (typeof tool_input.file_path === "string" && tool_input.file_path) ||
        (typeof tool_input.path === "string" && tool_input.path) ||
        "";
      if (!target) return { allow: true };
      return decideWrite(target, { projectRoot: ctx.projectRoot });
    }
    case "WebFetch":
    case "WebSearch": {
      const url = typeof tool_input.url === "string" ? tool_input.url : "";
      if (!url) return { allow: true };
      return decideUrl(url, { projectRoot: ctx.projectRoot, allowedDomains: ctx.allowedDomains });
    }
    default:
      return { allow: true };
  }
}

export async function loadAllowedDomains(projectRoot: string): Promise<string[]> {
  const file = path.join(projectRoot, ".sprint-orchestrator", "allowed-domains.txt");
  try {
    const raw = await fs.readFile(file, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch {
    return [];
  }
}

const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  readStdinJson<PreToolUseInput>()
    .then((input) => handlePreToolUse(input))
    .then((output) => {
      if (output) writeJson(output);
    })
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[pre-tool-use]", err);
    });
}
