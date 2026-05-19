import { afterEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { gh } from "../src/lib/gh.js";
import { loadRolePermissions } from "../src/state/load-role-permissions.js";
import { GhSubcommandDeniedError } from "../src/errors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PLUGIN_ROOT = path.join(HERE, "fixtures");
const REAL_PLUGIN_ROOT = path.resolve(HERE, "..", "..");

interface CreatedClient {
  client: Client;
  cleanup: () => Promise<void>;
}

async function buildServerAndClient(opts: {
  noopHandler: ReturnType<typeof vi.fn>;
  forbiddenHandler: ReturnType<typeof vi.fn>;
}): Promise<CreatedClient> {
  const server = createServer({
    permissionsLoader: async (role) =>
      loadRolePermissions({ role, pluginRoot: FIXTURE_PLUGIN_ROOT }),
  });

  server.registerTool({
    name: "noop",
    description: "test-only no-op tool",
    inputSchema: { type: "object" },
    handler: opts.noopHandler,
  });
  server.registerTool({
    name: "forbidden",
    description: "test-only forbidden tool",
    inputSchema: { type: "object" },
    handler: opts.forbiddenHandler,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "permissions-test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("permission enforcement (tool layer)", () => {
  let active: CreatedClient | undefined;

  afterEach(async () => {
    if (active) {
      await active.cleanup();
      active = undefined;
    }
  });

  it("AC5a: refuses an unlisted tool with the typed message; handler never invoked", async () => {
    const noopHandler = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    const forbiddenHandler = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "should-never-run" }],
    }));

    active = await buildServerAndClient({ noopHandler, forbiddenHandler });

    const result = await active.client.callTool({
      name: "forbidden",
      arguments: {},
      _meta: { role: "test-role" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toMatch(/Role 'test-role' is not allowed to invoke tool 'forbidden'/);
    expect(text).toContain("(FR79/FR80/NFR12)");
    expect(text).toContain("permissions/test-role.yaml");

    expect(forbiddenHandler).toHaveBeenCalledTimes(0);
    expect(noopHandler).toHaveBeenCalledTimes(0);
  });

  it("AC5d (tool): permits a listed tool; handler invoked exactly once with role context", async () => {
    const noopHandler = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    const forbiddenHandler = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "should-never-run" }],
    }));

    active = await buildServerAndClient({ noopHandler, forbiddenHandler });

    const result = await active.client.callTool({
      name: "noop",
      arguments: {},
      _meta: { role: "test-role" },
    });

    expect(result.isError).not.toBe(true);
    expect(noopHandler).toHaveBeenCalledTimes(1);
    expect(forbiddenHandler).toHaveBeenCalledTimes(0);

    const ctxArg = noopHandler.mock.calls[0]![1] as {
      role?: string;
      permissions?: { role?: string };
    };
    expect(ctxArg?.role).toBe("test-role");
    expect(ctxArg?.permissions?.role).toBe("test-role");
  });
});

describe("gh wrapper enforcement", () => {
  it("AC5b: refuses an unlisted subcommand with GhSubcommandDeniedError; execa never called", async () => {
    const perms = await loadRolePermissions({
      role: "test-role",
      pluginRoot: FIXTURE_PLUGIN_ROOT,
    });
    const execaImpl = vi.fn();

    await expect(
      gh({
        role: "test-role",
        permissions: perms,
        subcommand: "pr-merge",
        execaImpl: execaImpl as unknown as Parameters<typeof gh>[0]["execaImpl"],
      }),
    ).rejects.toBeInstanceOf(GhSubcommandDeniedError);

    try {
      await gh({
        role: "test-role",
        permissions: perms,
        subcommand: "pr-merge",
        execaImpl: execaImpl as unknown as Parameters<typeof gh>[0]["execaImpl"],
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GhSubcommandDeniedError);
      expect((err as Error).message).toMatch(
        /Role 'test-role' is not allowed to invoke 'gh pr-merge'/,
      );
      expect((err as Error).message).toContain("(NFR17)");
    }

    expect(execaImpl).toHaveBeenCalledTimes(0);
  });

  it("AC5d (gh): permits a listed subcommand; splits kebab to gh segments", async () => {
    const perms = await loadRolePermissions({
      role: "test-role",
      pluginRoot: FIXTURE_PLUGIN_ROOT,
    });
    const execaImpl = vi.fn(async () => ({
      stdout: "ok",
      stderr: "",
      exitCode: 0,
    }));

    const result = await gh({
      role: "test-role",
      permissions: perms,
      subcommand: "pr-view",
      args: ["--help"],
      execaImpl: execaImpl as unknown as Parameters<typeof gh>[0]["execaImpl"],
    });

    expect(result).toEqual({ stdout: "ok", stderr: "", exitCode: 0 });
    expect(execaImpl).toHaveBeenCalledTimes(1);
    expect(execaImpl).toHaveBeenCalledWith("gh", ["pr", "view", "--help"]);
  });
});

describe("shipped role specs (AC5e)", () => {
  it("loads generalist-dev with non-empty tools_allow and gh_allow", async () => {
    const perms = await loadRolePermissions({
      role: "generalist-dev",
      pluginRoot: REAL_PLUGIN_ROOT,
    });
    expect(perms.role).toBe("generalist-dev");
    expect(perms.tools_allow.length).toBeGreaterThan(0);
    expect(perms.gh_allow.length).toBeGreaterThan(0);
    expect(perms.tools_allow).toContain("claimStory");
    expect(perms.tools_allow).toContain("completeStory");
  });

  it("loads generalist-reviewer and asserts negative-capability (no pr-merge/pr-close/pr-review)", async () => {
    const perms = await loadRolePermissions({
      role: "generalist-reviewer",
      pluginRoot: REAL_PLUGIN_ROOT,
    });
    expect(perms.role).toBe("generalist-reviewer");
    expect(perms.tools_allow.length).toBeGreaterThan(0);
    expect(perms.gh_allow.length).toBeGreaterThan(0);
    expect(perms.gh_allow).not.toContain("pr-merge");
    expect(perms.gh_allow).not.toContain("pr-close");
    expect(perms.gh_allow).not.toContain("pr-review");
  });
});
