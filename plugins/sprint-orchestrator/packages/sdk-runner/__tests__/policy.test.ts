import { describe, it, expect } from "vitest";
import { decide, ALLOWED_BUILTIN_TOOLS, ALLOWED_MCP_PREFIX } from "../src/policy.js";

describe("decide", () => {
  for (const name of ALLOWED_BUILTIN_TOOLS) {
    it(`allows builtin tool: ${name}`, () => {
      expect(decide(name).allow).toBe(true);
    });
  }

  it("allows any tool under the sprint-orchestrator MCP namespace", () => {
    expect(decide(`${ALLOWED_MCP_PREFIX}getSprintStatus`).allow).toBe(true);
    expect(decide(`${ALLOWED_MCP_PREFIX}commitStoryArtefacts`).allow).toBe(true);
  });

  it("denies tools outside the allowlist", () => {
    const denials = ["WebFetch", "WebSearch", "NotebookEdit", "mcp__other__foo", ""];
    for (const t of denials) {
      const r = decide(t);
      expect(r.allow).toBe(false);
      if (!r.allow) expect(r.reason).toMatch(/^not-allowlisted:/);
    }
  });
});
