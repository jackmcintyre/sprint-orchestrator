import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendRunLog, FORMATTABLE, TEST_CMD_HINT, formatFile, handlePostToolUse } from "../src/post-tool-use.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "post-hook-"));
  cleanups.push(async () => fs.rm(root, { recursive: true, force: true }));
  return root;
}

describe("post-tool-use", () => {
  it("FORMATTABLE matches typescript/javascript variants", () => {
    const re = FORMATTABLE;
    for (const p of ["a.ts", "b.tsx", "c.js", "d.jsx", "e.mjs", "f.cjs"]) expect(re.test(p)).toBe(true);
    for (const p of ["a.md", "b.json", "c.txt", "d.py"]) expect(re.test(p)).toBe(false);
  });

  it("TEST_CMD_HINT matches common test invocations", () => {
    const re = TEST_CMD_HINT;
    for (const c of ["pnpm test", "pnpm -r test", "npm test", "yarn vitest", "pnpm jest --watch"])
      expect(re.test(c)).toBe(true);
    for (const c of ["pnpm build", "ls", "git log"]) expect(re.test(c)).toBe(false);
  });

  it("formatFile rewrites a TS file with prettier from the plugin's deps", async () => {
    const root = await makeRoot();
    const target = path.join(root, "messy.ts");
    await fs.writeFile(target, "const   x   =   1;\n", "utf8");
    await formatFile(root, target);
    const after = await fs.readFile(target, "utf8");
    expect(after).toBe("const x = 1;\n");
  });

  it("handlePostToolUse on null input is a no-op", async () => {
    await expect(handlePostToolUse(null)).resolves.toBeUndefined();
  });

  it("handlePostToolUse logs test runs to run.log", async () => {
    const root = await makeRoot();
    await handlePostToolUse({
      cwd: root,
      tool_name: "Bash",
      tool_input: { command: "pnpm -r test" },
      tool_response: { exit_code: 0 },
    });
    const log = await fs.readFile(path.join(root, ".sprint-orchestrator", "run.log"), "utf8");
    expect(log).toContain("test_run");
    expect(log).toContain("pnpm -r test");
  });

  it("handlePostToolUse ignores non-test Bash commands", async () => {
    const root = await makeRoot();
    await handlePostToolUse({
      cwd: root,
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: { exit_code: 0 },
    });
    await expect(fs.access(path.join(root, ".sprint-orchestrator", "run.log"))).rejects.toThrow();
  });

  it("appendRunLog writes one JSON line per call into .sprint-orchestrator/run.log", async () => {
    const root = await makeRoot();
    await appendRunLog(root, { event: "test_run", exit_code: 0 });
    await appendRunLog(root, { event: "test_run", exit_code: 1 });
    const log = await fs.readFile(path.join(root, ".sprint-orchestrator", "run.log"), "utf8");
    const lines = log.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).exit_code).toBe(0);
    expect(JSON.parse(lines[1]!).exit_code).toBe(1);
  });
});
