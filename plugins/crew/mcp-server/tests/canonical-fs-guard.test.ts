import { afterAll, describe, expect, it } from "vitest";
import { promises as fs, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { writeManagedFile } from "../src/lib/managed-fs.js";
import { CanonicalFsWriteError } from "../src/errors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(HERE, "..", "src");

const FS_WRITE_WHITELIST = new Set<string>([
  path.join(SRC_DIR, "lib", "managed-fs.ts"),
  path.join(SRC_DIR, "lib", "logger.ts"),
]);

const BANNED_WRITE_BINDINGS = [
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "createWriteStream",
];

const FS_MODULE_NAMES = new Set([
  "fs",
  "fs/promises",
  "node:fs",
  "node:fs/promises",
]);

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      walkTs(full, out);
    } else if (s.isFile() && full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("writeManagedFile runtime guard (AC5c runtime)", () => {
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

  it("rejects canonical-state writes without an MCP tool context", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "managed-fs-canonical-"));
    tmpDirs.push(root);
    const target = path.join(root, ".crew", "state", "to-do", "bmad:1.yaml");

    await expect(
      writeManagedFile({
        absPath: target,
        contents: "x",
        targetRepoRoot: root,
      }),
    ).rejects.toBeInstanceOf(CanonicalFsWriteError);

    try {
      await writeManagedFile({
        absPath: target,
        contents: "x",
        targetRepoRoot: root,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CanonicalFsWriteError);
      const e = err as CanonicalFsWriteError;
      expect(e.message).toContain(target);
      expect(e.message).toContain(".crew/state/**");
      expect(e.message).toContain("(FR81/NFR16)");
    }
  });

  it("permits non-canonical writes without an MCP tool context", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "managed-fs-nocanon-"));
    tmpDirs.push(root);
    const target = path.join(root, "scratch.txt");

    await writeManagedFile({
      absPath: target,
      contents: "scratch-contents",
      targetRepoRoot: root,
    });

    const contents = await fs.readFile(target, "utf8");
    expect(contents).toBe("scratch-contents");
  });

  it("permits canonical writes when an MCP tool context is provided", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "managed-fs-mcpctx-"));
    tmpDirs.push(root);
    const target = path.join(root, ".crew", "state", "to-do", "bmad:2.yaml");

    await writeManagedFile({
      absPath: target,
      contents: "canonical-ok",
      targetRepoRoot: root,
      mcpToolContext: { toolName: "claimStory", role: "generalist-dev" },
    });

    const contents = await fs.readFile(target, "utf8");
    expect(contents).toBe("canonical-ok");
  });
});

describe("static fs-write guard (AC5c static)", () => {
  const allSources = walkTs(SRC_DIR);

  it("no file under mcp-server/src/** (other than managed-fs.ts) imports a write-shaped fs API", () => {
    const importRegex =
      /import\s+(?:type\s+)?(?:\{([^}]*)\}|(\*\s+as\s+\w+)|(\w+))\s+from\s+["']([^"']+)["']/g;
    const offences: string[] = [];

    for (const file of allSources) {
      if (FS_WRITE_WHITELIST.has(file)) continue;
      const body = readFileSync(file, "utf8");

      let match: RegExpExecArray | null;
      importRegex.lastIndex = 0;
      while ((match = importRegex.exec(body)) !== null) {
        const namedClause = match[1];
        const namespaceClause = match[2];
        const moduleName = match[4]!;
        if (!FS_MODULE_NAMES.has(moduleName)) continue;

        if (namedClause) {
          // Parse named bindings like `promises as fs, readFile, writeFile`.
          const names = namedClause
            .split(",")
            .map((n) => n.trim())
            .map((n) => {
              const renamed = n.split(/\s+as\s+/);
              return (renamed[0] ?? "").trim();
            })
            .filter((n) => n.length > 0);

          for (const name of names) {
            if (BANNED_WRITE_BINDINGS.includes(name)) {
              offences.push(`${file}: imports banned binding '${name}' from '${moduleName}'`);
            }
          }
        }

        if (namespaceClause) {
          // `import * as fs from "node:fs"` — check the body for `fs.writeFile` etc.
          const aliasMatch = namespaceClause.match(/\*\s+as\s+(\w+)/);
          const alias = aliasMatch?.[1];
          if (alias) {
            for (const banned of BANNED_WRITE_BINDINGS) {
              const re = new RegExp(`\\b${alias}\\.${banned}\\b`);
              if (re.test(body)) {
                offences.push(
                  `${file}: uses banned API '${alias}.${banned}' via namespace import of '${moduleName}'`,
                );
              }
            }
          }
        }
      }

      // Also catch `import { promises as fs } from "node:fs"` followed by
      // `fs.writeFile(...)` etc. The named-clause parsing above only flags
      // the literal `writeFile` binding; for `promises as fs` we need to
      // scan body for `fs.writeFile`.
      const promisesAliasRegex =
        /import\s+\{\s*promises\s+as\s+(\w+)\s*\}\s+from\s+["'](?:node:)?fs["']/g;
      let aliasMatch: RegExpExecArray | null;
      while ((aliasMatch = promisesAliasRegex.exec(body)) !== null) {
        const alias = aliasMatch[1]!;
        for (const banned of BANNED_WRITE_BINDINGS) {
          const re = new RegExp(`\\b${alias}\\.${banned}\\b`);
          if (re.test(body)) {
            offences.push(
              `${file}: uses banned API '${alias}.${banned}' via 'promises as ${alias}' import`,
            );
          }
        }
      }
    }

    expect(offences, offences.join("\n")).toEqual([]);
  });
});

describe("static direct-gh-spawn guard (AC5b static)", () => {
  const GH_WRAPPER = path.join(SRC_DIR, "lib", "gh.ts");
  const allSources = walkTs(SRC_DIR);

  it("no file under mcp-server/src/** (other than lib/gh.ts) spawns `gh` directly", () => {
    const patterns: RegExp[] = [
      /execa\s*\(\s*["']gh["']/,
      /spawn\s*\(\s*["']gh["']/,
      /spawnSync\s*\(\s*["']gh["']/,
      /exec\s*\(\s*["']gh\s/,
    ];

    const offences: string[] = [];
    for (const file of allSources) {
      if (file === GH_WRAPPER) continue;
      const body = readFileSync(file, "utf8");
      for (const re of patterns) {
        if (re.test(body)) {
          offences.push(`${file}: direct gh spawn matched ${re}`);
        }
      }
    }

    expect(offences, offences.join("\n")).toEqual([]);
  });
});

describe("static direct-rename guard (Story 1.6 AC6g)", () => {
  const RENAME_WRAPPER = path.join(SRC_DIR, "state", "manifest-state-machine.ts");
  const allSources = walkTs(SRC_DIR);

  const BANNED_RENAME_BINDINGS = ["rename", "renameSync"];

  it("no file under mcp-server/src/** (other than state/manifest-state-machine.ts) imports or invokes rename against a state-machine path", () => {
    const importRegex =
      /import\s+(?:type\s+)?(?:\{([^}]*)\}|(\*\s+as\s+\w+)|(\w+))\s+from\s+["']([^"']+)["']/g;
    const offences: string[] = [];

    for (const file of allSources) {
      if (file === RENAME_WRAPPER) continue;
      const body = readFileSync(file, "utf8");

      let match: RegExpExecArray | null;
      importRegex.lastIndex = 0;
      while ((match = importRegex.exec(body)) !== null) {
        const namedClause = match[1];
        const namespaceClause = match[2];
        const moduleName = match[4]!;
        if (!FS_MODULE_NAMES.has(moduleName)) continue;

        if (namedClause) {
          const names = namedClause
            .split(",")
            .map((n) => n.trim())
            .map((n) => {
              const renamed = n.split(/\s+as\s+/);
              return (renamed[0] ?? "").trim();
            })
            .filter((n) => n.length > 0);

          for (const name of names) {
            if (BANNED_RENAME_BINDINGS.includes(name)) {
              offences.push(
                `${file}: imports banned rename binding '${name}' from '${moduleName}'`,
              );
            }
          }
        }

        if (namespaceClause) {
          const aliasMatch = namespaceClause.match(/\*\s+as\s+(\w+)/);
          const alias = aliasMatch?.[1];
          if (alias) {
            for (const banned of BANNED_RENAME_BINDINGS) {
              const re = new RegExp(`\\b${alias}\\.${banned}\\b`);
              if (re.test(body)) {
                offences.push(
                  `${file}: uses banned API '${alias}.${banned}' via namespace import of '${moduleName}'`,
                );
              }
              const promisesRe = new RegExp(`\\b${alias}\\.promises\\.${banned}\\b`);
              if (promisesRe.test(body)) {
                offences.push(
                  `${file}: uses banned API '${alias}.promises.${banned}' via namespace import of '${moduleName}'`,
                );
              }
            }
          }
        }
      }

      const promisesAliasRegex =
        /import\s+\{\s*promises\s+as\s+(\w+)\s*\}\s+from\s+["'](?:node:)?fs["']/g;
      let aliasMatch: RegExpExecArray | null;
      while ((aliasMatch = promisesAliasRegex.exec(body)) !== null) {
        const alias = aliasMatch[1]!;
        for (const banned of BANNED_RENAME_BINDINGS) {
          const re = new RegExp(`\\b${alias}\\.${banned}\\b`);
          if (re.test(body)) {
            offences.push(
              `${file}: uses banned API '${alias}.${banned}' via 'promises as ${alias}' import`,
            );
          }
        }
      }
    }

    expect(offences, offences.join("\n")).toEqual([]);
  });
});

describe("static direct-git-spawn guard (Story 1.5 AC6f)", () => {
  const GIT_WRAPPER = path.join(SRC_DIR, "lib", "git.ts");
  const allSources = walkTs(SRC_DIR);

  it("no file under mcp-server/src/** (other than lib/git.ts) spawns `git` directly", () => {
    const patterns: RegExp[] = [
      /execa\s*\(\s*["']git["']/,
      /spawn\s*\(\s*["']git["']/,
      /spawnSync\s*\(\s*["']git["']/,
      /exec\s*\(\s*["']git\s/,
    ];

    const offences: string[] = [];
    for (const file of allSources) {
      if (file === GIT_WRAPPER) continue;
      const body = readFileSync(file, "utf8");
      for (const re of patterns) {
        if (re.test(body)) {
          offences.push(`${file}: direct git spawn matched ${re}`);
        }
      }
    }

    expect(offences, offences.join("\n")).toEqual([]);
  });
});
