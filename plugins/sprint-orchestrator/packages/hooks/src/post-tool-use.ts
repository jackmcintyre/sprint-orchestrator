import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { readStdinJson } from "./lib/io.js";

export interface PostToolUseInput {
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; path?: string; command?: string };
  tool_response?: { exit_code?: number; stdout?: string; stderr?: string };
}

export const FORMATTABLE = /\.(tsx?|jsx?|mjs|cjs)$/i;
export const TEST_CMD_HINT = /\b(pnpm|npm|yarn)\s+(-\w+\s+)*(test|vitest|jest)\b/;

export async function handlePostToolUse(input: PostToolUseInput | null): Promise<void> {
  if (!input) return;
  const projectRoot = input.cwd ?? process.cwd();

  if (input.tool_name === "Write" || input.tool_name === "Edit" || input.tool_name === "MultiEdit") {
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
}

export async function formatFile(projectRoot: string, target: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn("pnpm", ["prettier", "--write", target], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

export async function appendRunLog(projectRoot: string, entry: Record<string, unknown>): Promise<void> {
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
