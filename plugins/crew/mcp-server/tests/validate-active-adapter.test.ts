import { describe, it, expect } from "vitest";
import { z } from "zod";
import { validateActiveAdapter } from "../src/state/validate-active-adapter.js";
import { StaleWorkspaceConfigError, NotImplementedError } from "../src/errors.js";
import type { PlanningAdapter, SourceStory } from "../src/adapters/adapter.js";
import type { Workspace } from "../src/state/workspace-resolver.js";

function makeStubAdapter(opts: {
  name: string;
  detectResult: boolean;
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
      return {};
    },
    adapterConfigSchema: z.record(z.string(), z.unknown()),
  };
}

function makeSyntheticWorkspace(activeAdapter: PlanningAdapter): Workspace {
  return {
    targetRepoRoot: "/tmp/anything",
    activeAdapterName: activeAdapter.name,
    activeAdapter,
    adapterConfig: {},
    pluginSettings: {
      agreement_threshold: 0.8,
      orchestration_interval_seconds: 120,
    },
  };
}

describe("validateActiveAdapter", () => {
  it("AC4a: configured adapter matches → returns the same Workspace reference", async () => {
    const stubA = makeStubAdapter({ name: "stubA", detectResult: true });
    const workspace = makeSyntheticWorkspace(stubA);

    const result = await validateActiveAdapter(workspace, { adapters: [stubA] });

    expect(result).toBe(workspace);
  });

  it("AC4b: configured mismatches, another matches → throws StaleWorkspaceConfigError with redirect", async () => {
    const stubA = makeStubAdapter({ name: "stubA", detectResult: false });
    const stubB = makeStubAdapter({ name: "stubB", detectResult: true });
    const workspace = makeSyntheticWorkspace(stubA);

    await expect(
      validateActiveAdapter(workspace, { adapters: [stubA, stubB] }),
    ).rejects.toThrow(StaleWorkspaceConfigError);

    try {
      await validateActiveAdapter(workspace, { adapters: [stubA, stubB] });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StaleWorkspaceConfigError);
      const e = err as StaleWorkspaceConfigError;
      expect(e.configuredAdapter).toBe("stubA");
      expect(e.otherMatchingAdapters).toEqual(["stubB"]);
      expect(e.message).toContain("stubA");
      expect(e.message).toContain("false");
      expect(e.message).toContain("stubB");
    }
  });

  it("AC4c: configured mismatches, none others match → throws StaleWorkspaceConfigError with schema-rewrite guidance", async () => {
    const stubA = makeStubAdapter({ name: "stubA", detectResult: false });
    const stubC = makeStubAdapter({ name: "stubC", detectResult: false });
    const workspace = makeSyntheticWorkspace(stubA);

    await expect(
      validateActiveAdapter(workspace, { adapters: [stubA, stubC] }),
    ).rejects.toThrow(StaleWorkspaceConfigError);

    try {
      await validateActiveAdapter(workspace, { adapters: [stubA, stubC] });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StaleWorkspaceConfigError);
      const e = err as StaleWorkspaceConfigError;
      expect(e.configuredAdapter).toBe("stubA");
      expect(e.otherMatchingAdapters).toEqual([]);
      expect(e.message).toContain("stubA");
      expect(e.message).toContain("false");
      expect(e.message).toContain("mcp-server/src/schemas/workspace-config.ts");
      // AC3: message also points the user at the canonical example
      expect(e.message).toContain(
        "plugins/crew/example/.crew/config.yaml",
      );
      expect(e.schemaModule).toBe("mcp-server/src/schemas/workspace-config.ts");
    }
  });

  it("AC1: configured adapter's detect() is called before any other work (no cross-check when it matches)", async () => {
    // AC1 semantic: helper gates skill work on detect(); when configured adapter
    // matches, no other adapter's detect() is consulted (single call, gate-only).
    let configuredCalls = 0;
    let otherCalls = 0;
    const stubA: PlanningAdapter = {
      name: "stubA",
      async detect(_t: string) {
        configuredCalls++;
        return true;
      },
      async listSourceStories() {
        return [];
      },
      async readSourceStory() {
        throw new NotImplementedError("stub");
      },
      resolveSourcePath() {
        throw new NotImplementedError("stub");
      },
      defaultConfig() {
        return {};
      },
      adapterConfigSchema: z.record(z.string(), z.unknown()),
    };
    const stubOther: PlanningAdapter = {
      name: "stubOther",
      async detect(_t: string) {
        otherCalls++;
        return true;
      },
      async listSourceStories() {
        return [];
      },
      async readSourceStory() {
        throw new NotImplementedError("stub");
      },
      resolveSourcePath() {
        throw new NotImplementedError("stub");
      },
      defaultConfig() {
        return {};
      },
      adapterConfigSchema: z.record(z.string(), z.unknown()),
    };
    const workspace = makeSyntheticWorkspace(stubA);

    const result = await validateActiveAdapter(workspace, {
      adapters: [stubA, stubOther],
    });

    expect(result).toBe(workspace);
    expect(configuredCalls).toBe(1);
    expect(otherCalls).toBe(0);
  });
});
