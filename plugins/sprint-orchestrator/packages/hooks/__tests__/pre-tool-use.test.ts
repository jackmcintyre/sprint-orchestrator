import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { evaluate, handlePreToolUse, loadAllowedDomains as loadDomains } from "../src/pre-tool-use.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pre-hook-"));
  cleanups.push(async () => fs.rm(root, { recursive: true, force: true }));
  return root;
}

describe("pre-tool-use evaluate", () => {
  it("allows benign Bash", async () => {
    const r = await evaluate(
      { tool_name: "Bash", tool_input: { command: "git status" } },
      { projectRoot: "/", allowedDomains: [] },
    );
    expect(r.allow).toBe(true);
  });

  it("denies destructive Bash", async () => {
    const r = await evaluate(
      { tool_name: "Bash", tool_input: { command: "rm -rf /" } },
      { projectRoot: "/", allowedDomains: [] },
    );
    expect(r.allow).toBe(false);
  });

  it("denies Write outside project root", async () => {
    const r = await evaluate(
      { tool_name: "Write", tool_input: { file_path: "/etc/passwd" } },
      { projectRoot: "/tmp/proj", allowedDomains: [] },
    );
    expect(r.allow).toBe(false);
  });

  it("allows Write inside project root", async () => {
    const r = await evaluate(
      { tool_name: "Write", tool_input: { file_path: "src/foo.ts" } },
      { projectRoot: "/tmp/proj", allowedDomains: [] },
    );
    expect(r.allow).toBe(true);
  });

  it("denies WebFetch when allowlist is empty", async () => {
    const r = await evaluate(
      { tool_name: "WebFetch", tool_input: { url: "https://example.com" } },
      { projectRoot: "/", allowedDomains: [] },
    );
    expect(r.allow).toBe(false);
  });

  it("allows WebFetch to allowed host", async () => {
    const r = await evaluate(
      { tool_name: "WebFetch", tool_input: { url: "https://api.github.com/x" } },
      { projectRoot: "/", allowedDomains: ["api.github.com"] },
    );
    expect(r.allow).toBe(true);
  });

  it("passes through unknown tools", async () => {
    const r = await evaluate(
      { tool_name: "Read", tool_input: { file_path: "anything" } },
      { projectRoot: "/", allowedDomains: [] },
    );
    expect(r.allow).toBe(true);
  });
});

describe("handlePreToolUse", () => {
  it("returns null on null input", async () => {
    expect(await handlePreToolUse(null)).toBeNull();
  });

  it("returns null on unknown tool", async () => {
    expect(await handlePreToolUse({ tool_name: "Read", tool_input: {} })).toBeNull();
  });

  it("returns a deny output when bash matches a destructive pattern", async () => {
    const r = await handlePreToolUse({ tool_name: "Bash", tool_input: { command: "rm -rf /" } });
    expect(r?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(r?.hookSpecificOutput.permissionDecisionReason).toMatch(/bash:/);
  });
});

describe("loadAllowedDomains", () => {
  it("returns [] when file is missing", async () => {
    const root = await makeRoot();
    expect(await loadDomains(root)).toEqual([]);
  });

  it("parses one host per line, ignoring blanks and comments", async () => {
    const root = await makeRoot();
    await fs.mkdir(path.join(root, ".sprint-orchestrator"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".sprint-orchestrator", "allowed-domains.txt"),
      "# trusted\napi.github.com\n\n*.anthropic.com\n",
      "utf8",
    );
    expect(await loadDomains(root)).toEqual(["api.github.com", "*.anthropic.com"]);
  });
});
