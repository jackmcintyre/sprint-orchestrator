import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parse as yamlParse } from "yaml";
import { resolveWorkspace } from "../src/state/workspace-resolver.js";
import type { PlanningAdapter, SourceStory } from "../src/adapters/adapter.js";
import {
  AmbiguousAdapterError,
  InvalidWorkspaceConfigError,
  NoAdapterMatchedError,
  NotImplementedError,
} from "../src/errors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "workspace-resolver");

function makeStubAdapter(opts: {
  name: string;
  detectResult: boolean;
  defaultCfg?: Record<string, unknown>;
  schema?: z.ZodTypeAny;
}): PlanningAdapter {
  return {
    name: opts.name,
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
      return opts.defaultCfg ?? {};
    },
    adapterConfigSchema: opts.schema ?? z.record(z.string(), z.unknown()),
  };
}

async function copyFixtureToTmp(fixtureName: string): Promise<string> {
  const src = path.join(FIXTURES, fixtureName);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `wsres-${fixtureName}-`));
  await fs.cp(src, tmp, { recursive: true });
  return tmp;
}

async function makeEmptyTmpRepo(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "wsres-empty-"));
}

describe("resolveWorkspace", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    while (tmpDirs.length) {
      const d = tmpDirs.pop()!;
      try {
        await fs.rm(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("AC4a: loads a valid bmad config and exposes the Workspace", async () => {
    const tmp = await copyFixtureToTmp("valid-bmad");
    tmpDirs.push(tmp);

    const ws = await resolveWorkspace({ targetRepoRoot: tmp });

    expect(ws.targetRepoRoot).toBe(path.resolve(tmp));
    expect(ws.activeAdapterName).toBe("bmad");
    expect(ws.activeAdapter.name).toBe("bmad");
    expect(ws.adapterConfig).toEqual({
      stories_root: "_bmad-output/planning-artifacts/stories",
    });
    // Partial plugin block in the fixture overrides agreement_threshold;
    // orchestration_interval_seconds gets the documented default.
    expect(ws.pluginSettings.agreement_threshold).toBe(0.9);
    expect(ws.pluginSettings.orchestration_interval_seconds).toBe(120);
  });

  it("AC4b: missing config + exactly one detect() match writes config and is idempotent", async () => {
    const tmp = await makeEmptyTmpRepo();
    tmpDirs.push(tmp);

    const stub = makeStubAdapter({
      name: "stubA",
      detectResult: true,
      defaultCfg: { stories_root: "stories/" },
      schema: z.object({ stories_root: z.string() }),
    });

    const ws1 = await resolveWorkspace({ targetRepoRoot: tmp, adapters: [stub] });
    expect(ws1.activeAdapterName).toBe("stubA");
    expect(ws1.adapterConfig).toEqual({ stories_root: "stories/" });
    expect(ws1.pluginSettings.agreement_threshold).toBe(0.8);
    expect(ws1.pluginSettings.orchestration_interval_seconds).toBe(120);

    const configPath = path.join(tmp, ".crew", "config.yaml");
    const written = await fs.readFile(configPath, "utf8");
    const parsed = yamlParse(written) as { adapter: string };
    expect(parsed.adapter).toBe("stubA");

    // Second call parses the just-written file via the same code path.
    const ws2 = await resolveWorkspace({ targetRepoRoot: tmp, adapters: [stub] });
    expect(ws2.activeAdapterName).toBe(ws1.activeAdapterName);
    expect(ws2.adapterConfig).toEqual(ws1.adapterConfig);
    expect(ws2.pluginSettings).toEqual(ws1.pluginSettings);
  });

  it("AC4c: invalid config (unknown adapter name) throws InvalidWorkspaceConfigError", async () => {
    const tmp = await copyFixtureToTmp("invalid");
    tmpDirs.push(tmp);

    await expect(resolveWorkspace({ targetRepoRoot: tmp })).rejects.toMatchObject({
      name: "InvalidWorkspaceConfigError",
      yamlPath: "adapter",
      schemaModule: "mcp-server/src/schemas/workspace-config.ts",
    });

    try {
      await resolveWorkspace({ targetRepoRoot: tmp });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidWorkspaceConfigError);
      const e = err as InvalidWorkspaceConfigError;
      expect(e.message).toContain("adapter");
      expect(e.message).toContain("nonexistent");
      expect(e.message).toContain("mcp-server/src/schemas/workspace-config.ts");
    }
  });

  it("AC4d: no detect() matches throws NoAdapterMatchedError and writes no config", async () => {
    const tmp = await makeEmptyTmpRepo();
    tmpDirs.push(tmp);

    const stub = makeStubAdapter({ name: "stubA", detectResult: false });

    await expect(
      resolveWorkspace({ targetRepoRoot: tmp, adapters: [stub] }),
    ).rejects.toBeInstanceOf(NoAdapterMatchedError);

    const configPath = path.join(tmp, ".crew", "config.yaml");
    await expect(fs.stat(configPath)).rejects.toThrow();
  });

  it("AC4e: two detect() matches throws AmbiguousAdapterError and writes no config", async () => {
    const tmp = await makeEmptyTmpRepo();
    tmpDirs.push(tmp);

    const stubA = makeStubAdapter({ name: "stubA", detectResult: true });
    const stubB = makeStubAdapter({ name: "stubB", detectResult: true });

    try {
      await resolveWorkspace({ targetRepoRoot: tmp, adapters: [stubA, stubB] });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousAdapterError);
      const e = err as AmbiguousAdapterError;
      expect(e.matchingAdapters).toEqual(["stubA", "stubB"]);
      expect(e.message).toContain("stubA");
      expect(e.message).toContain("stubB");
    }

    const configPath = path.join(tmp, ".crew", "config.yaml");
    await expect(fs.stat(configPath)).rejects.toThrow();
  });
});
