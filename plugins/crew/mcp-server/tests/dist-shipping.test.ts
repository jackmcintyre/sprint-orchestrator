import { describe, it, expect } from "vitest";
import { execa } from "execa";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Story 1.9 — Ship a pre-built dist/ with the plugin.
 *
 * Two blocks:
 *  (a) DRIFT — rebuild `dist/` into a temp dir and assert it matches the
 *      committed `dist/` byte-for-byte. Mirrors the CI step.
 *  (b) SENTINEL — dynamically import `dist/index.js` and
 *      `dist/tools/register.js`, asserting exports exist. Catches the
 *      partial-build / missing-tools-directory regression from PR #61.
 *
 * For the index.js sentinel we spawn a short-lived child process rather
 * than importing in-process — `dist/index.js` calls `main()` at module
 * top level which connects an stdio transport and would hang the test
 * worker. Spawning + sending EOF lets the process tear down cleanly.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, "..");
const DIST_DIR = resolve(SERVER_ROOT, "dist");
const REGISTER_DIST = resolve(DIST_DIR, "tools/register.js");
const INDEX_DIST = resolve(DIST_DIR, "index.js");

async function walkFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => {
      // Node's recursive readdir sets `parentPath` on each Dirent.
      const parent = (e as unknown as { parentPath?: string; path?: string })
        .parentPath ?? (e as unknown as { path?: string }).path ?? root;
      return relative(root, join(parent, e.name));
    })
    .sort();
}

describe("dist shipping contract (Story 1.9)", () => {
  describe("sentinel: committed dist/ exposes the expected modules", () => {
    it("dist/tools/register.js exports registerAllTools", async () => {
      const mod = await import(REGISTER_DIST);
      expect(typeof mod.registerAllTools).toBe("function");
    });

    it("dist/index.js exists and starts as a node module without immediate crash", async () => {
      // Spawn the entrypoint with stdin closed. The server connects an
      // stdio transport and waits for input; closing stdin immediately
      // should let it shut down. We assert it didn't crash with a
      // MODULE_NOT_FOUND-style error in the first 1500ms.
      const proc = execa("node", [INDEX_DIST], {
        reject: false,
        timeout: 1500,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const result = await proc;
      // If the module failed to resolve (e.g. dist/tools/ missing), the
      // process exits non-zero with a MODULE_NOT_FOUND on stderr.
      // A timeout (process kept running waiting for stdio) is the OK
      // outcome — execa surfaces it via `timedOut: true`.
      const stderr = result.stderr ?? "";
      expect(stderr).not.toMatch(/MODULE_NOT_FOUND|Cannot find module/);
    });
  });

  describe("drift: a fresh tsc build matches the committed dist/", () => {
    it("byte-equal file set and contents", async () => {
      const tmpRoot = await mkdtemp(join(tmpdir(), "crew-dist-drift-"));
      try {
        await execa(
          "pnpm",
          ["exec", "tsc", "-p", "tsconfig.json", "--outDir", tmpRoot],
          { cwd: SERVER_ROOT },
        );

        const [committed, fresh] = await Promise.all([
          walkFiles(DIST_DIR),
          walkFiles(tmpRoot),
        ]);

        // 1. file sets are identical
        const onlyInCommitted = committed.filter((f) => !fresh.includes(f));
        const onlyInFresh = fresh.filter((f) => !committed.includes(f));
        expect(
          { onlyInCommitted: onlyInCommitted.slice(0, 5), onlyInFresh: onlyInFresh.slice(0, 5) },
        ).toEqual({ onlyInCommitted: [], onlyInFresh: [] });

        // 2. contents match byte-for-byte
        const divergent: string[] = [];
        for (const rel of committed) {
          const a = await readFile(join(DIST_DIR, rel));
          const b = await readFile(join(tmpRoot, rel));
          if (!a.equals(b)) divergent.push(rel);
          if (divergent.length >= 5) break;
        }
        expect(divergent).toEqual([]);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    }, 60_000);
  });
});
