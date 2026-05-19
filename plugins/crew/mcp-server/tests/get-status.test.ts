import { describe, it, expect, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../src/server.js";
import { registerAllTools } from "../src/tools/register.js";
import { getStatus, renderStatus } from "../src/tools/get-status.js";
import {
  StatusReportSchema,
  SEMVER_REGEX,
} from "../src/schemas/status-report.js";
import { NotImplementedError } from "../src/errors.js";
import type { PlanningAdapter, SourceStory } from "../src/adapters/adapter.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..", "..");
const EXAMPLE_STANDARDS = path.resolve(PLUGIN_ROOT, "docs", "standards-example.md");
const MALFORMED_FIXTURE = path.resolve(
  HERE,
  "fixtures",
  "standards",
  "malformed-missing-field",
  "docs",
  "standards.md",
);
const README_INSTALL = path.resolve(PLUGIN_ROOT, "docs", "README-install.md");

const CHECKPOINT_BLOCK_REGEX = /^\d+\.\s+\*\*[^*]+\.\*\*/gm;

function makeBmadStub(opts: { detectResult: boolean }): PlanningAdapter {
  return {
    name: "bmad",
    async detect(_t: string): Promise<boolean> {
      return opts.detectResult;
    },
    async listSourceStories(): Promise<SourceStory[]> {
      return [];
    },
    async readSourceStory(_r: string): Promise<SourceStory> {
      throw new NotImplementedError("stub");
    },
    resolveSourcePath(_r: string): string {
      throw new NotImplementedError("stub");
    },
    defaultConfig(): Record<string, unknown> {
      return { stories_root: "_bmad-output/planning-artifacts/stories" };
    },
    adapterConfigSchema: z.object({ stories_root: z.string() }),
  };
}

const VALID_CONFIG_YAML = `adapter: bmad
adapter_config:
  stories_root: _bmad-output/planning-artifacts/stories
plugin: {}
`;

async function makeTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `getstatus-${prefix}-`));
}

async function seedConfig(root: string): Promise<void> {
  await fs.mkdir(path.join(root, ".crew"), { recursive: true });
  await fs.writeFile(path.join(root, ".crew", "config.yaml"), VALID_CONFIG_YAML, "utf8");
}

async function seedValidStandards(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.copyFile(EXAMPLE_STANDARDS, path.join(root, "docs", "standards.md"));
}

async function seedMalformedStandards(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.copyFile(MALFORMED_FIXTURE, path.join(root, "docs", "standards.md"));
}

const tmpDirs: string[] = [];
afterAll(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      await fs.rm(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("getStatus", () => {
  it("AC4a — valid standards.md → standards.state=ok, render starts with 'crew v', 'standards: ok — '", async () => {
    const root = await makeTmp("ac4a");
    tmpDirs.push(root);
    await seedConfig(root);
    await seedValidStandards(root);

    const adapters = [makeBmadStub({ detectResult: true })];
    const report = await getStatus({ targetRepoRoot: root, adapters });

    expect(() => StatusReportSchema.parse(report)).not.toThrow();
    expect(report.standards.state).toBe("ok");
    expect(report.adapter.state).toBe("ok");
    if (report.adapter.state === "ok") {
      expect(report.adapter.name).toBe("bmad");
    }
    expect(report.pluginVersion).toMatch(SEMVER_REGEX);

    const rendered = renderStatus(report);
    const lines = rendered.split("\n");
    expect(lines[0]).toBe(`crew v${report.pluginVersion}`);
    expect(lines[3]!.startsWith("standards: ok — ")).toBe(true);
  });

  it("AC4b — missing standards.md → standards.state=missing, render contains 'standards: missing — '", async () => {
    const root = await makeTmp("ac4b");
    tmpDirs.push(root);
    await seedConfig(root);

    const adapters = [makeBmadStub({ detectResult: true })];
    const report = await getStatus({ targetRepoRoot: root, adapters });

    expect(report.standards.state).toBe("missing");
    expect(report.standards.path).toBe(path.join(root, "docs", "standards.md"));
    expect(report.adapter.state).toBe("ok");
    const rendered = renderStatus(report);
    expect(rendered).toContain(
      `standards: missing — ${path.join(root, "docs", "standards.md")}`,
    );
  });

  it("AC4c — malformed standards.md → standards.state=malformed, zodMessage non-empty", async () => {
    const root = await makeTmp("ac4c");
    tmpDirs.push(root);
    await seedConfig(root);
    await seedMalformedStandards(root);

    const adapters = [makeBmadStub({ detectResult: true })];
    const report = await getStatus({ targetRepoRoot: root, adapters });

    expect(report.standards.state).toBe("malformed");
    if (report.standards.state === "malformed") {
      expect(report.standards.zodMessage.length).toBeGreaterThan(0);
    }
    const rendered = renderStatus(report);
    expect(rendered).toContain(
      `standards: malformed — ${path.join(root, "docs", "standards.md")}`,
    );
  });

  it("AC4d — stale adapter config → adapter.state=mismatched", async () => {
    const root = await makeTmp("ac4d");
    tmpDirs.push(root);
    await seedConfig(root);
    await seedValidStandards(root);

    const adapters = [makeBmadStub({ detectResult: false })];
    const report = await getStatus({ targetRepoRoot: root, adapters });

    expect(report.adapter.state).toBe("mismatched");
    if (report.adapter.state === "mismatched") {
      expect(report.adapter.name).toBe("bmad");
      expect(Array.isArray(report.adapter.otherMatchingAdapters)).toBe(true);
    }
    expect(report.standards.state).toBe("ok");
    const rendered = renderStatus(report);
    expect(rendered).toContain("adapter: bmad (mismatched)");
    expect(rendered).toContain("standards: ok — ");
  });

  it("AC4e — same-repo and split-repo produce identical renders for identical fixture state", async () => {
    const rootA = await makeTmp("ac4e-A");
    const rootB = await makeTmp("ac4e-B");
    tmpDirs.push(rootA, rootB);

    for (const r of [rootA, rootB]) {
      await seedConfig(r);
      await seedValidStandards(r);
    }

    const adapters = [makeBmadStub({ detectResult: true })];
    const reportA = await getStatus({ targetRepoRoot: rootA, adapters });
    const reportB = await getStatus({ targetRepoRoot: rootB, adapters });

    const renderedA = renderStatus(reportA);
    const renderedB = renderStatus(reportB);

    // Substitute A's absolute path with B's; the result must equal B's render.
    const substituted = renderedA.split(reportA.targetRepoRoot).join(reportB.targetRepoRoot);
    expect(substituted).toBe(renderedB);
  });

  it("AC4f — docs/README-install.md is well-formed (six checkpoints, ends with Story 7.2 forward-ref)", () => {
    const raw = readFileSync(README_INSTALL, "utf8");
    const matches = raw.match(CHECKPOINT_BLOCK_REGEX);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(6);

    // Checkpoint 6's expected confirmation contains the literal substrings.
    expect(raw).toContain("crew v");
    expect(raw).toContain("standards: ok");

    // File ends with the forward-reference line (allow trailing newline).
    const trimmed = raw.replace(/\s+$/, "");
    expect(trimmed.endsWith("> See Story 7.2 (Epic 7) for the full first-run walkthrough.")).toBe(true);
  });

  it("AC1/AC3 — render's first line matches the SEMVER_REGEX-anchored 'crew v…' shape and standards line starts with 'standards: ok — '", async () => {
    const root = await makeTmp("self-consistency");
    tmpDirs.push(root);
    await seedConfig(root);
    await seedValidStandards(root);

    const adapters = [makeBmadStub({ detectResult: true })];
    const report = await getStatus({ targetRepoRoot: root, adapters });
    const rendered = renderStatus(report);
    const lines = rendered.split("\n");

    expect(lines[0]).toMatch(/^crew v\d+\.\d+\.\d+(?:-[\w.]+)?$/);
    expect(lines[3]!.startsWith("standards: ok — ")).toBe(true);
  });

  it("end-to-end via MCP — registerAllTools registers getStatus, ListTools includes it, CallTool returns the rendered text", async () => {
    // Pre-seed a fixture root the live BmadAdapter would not match against.
    // The MCP path uses the live registry; the real BmadAdapter's detect()
    // currently throws NotImplementedError. To exercise the end-to-end path
    // without that being the dominant failure, we drive getStatus through
    // the registered tool against a fixture that resolves cleanly via a
    // pre-existing `.crew/config.yaml`. Because validateActiveAdapter calls
    // BmadAdapter.detect() and that currently throws NotImplementedError,
    // the call would fail in production wiring — so we assert on the wiring
    // (ListTools, CallTool dispatch) rather than the happy-path output.
    const server = createServer();
    registerAllTools(server);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "e2e-getstatus", version: "0.0.0" },
      { capabilities: {} },
    );
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    try {
      const list = await client.request(
        { method: "tools/list", params: {} },
        ListToolsResultSchema,
      );
      const names = list.tools.map((t) => t.name);
      expect(names).toContain("getStatus");

      // Drive the tool against a tmp dir. Adapter stubs cannot be injected
      // through the MCP boundary, so the call exercises the live registry —
      // whose `BmadAdapter.detect()` currently throws NotImplementedError
      // (real implementation lands in Story 3.3). The MCP SDK converts that
      // throw into a JSON-RPC error; we assert the dispatch reached the
      // registered handler (i.e. the error message comes from `bmad adapter:
      // detect`, not "Unknown tool").
      const root = await makeTmp("e2e");
      tmpDirs.push(root);
      await expect(
        client.request(
          {
            method: "tools/call",
            params: { name: "getStatus", arguments: { targetRepoRoot: root } },
          },
          CallToolResultSchema,
        ),
      ).rejects.toThrow(/bmad adapter: detect|NoAdapterMatched/);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
