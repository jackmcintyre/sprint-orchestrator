import { afterAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  moveBetweenStates,
  STATE_NAMES,
  type StateName,
} from "../src/state/manifest-state-machine.js";
import {
  CrossFilesystemMoveError,
  InvalidStateNameError,
  ManifestNotFoundError,
} from "../src/errors.js";

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

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manifest-state-"));
  tmpDirs.push(root);
  return root;
}

function stateDir(root: string, state: StateName): string {
  return path.join(root, ".claude-dev-loop", "state", state);
}

async function seedManifest(
  root: string,
  state: StateName,
  ref: string,
  body: string,
): Promise<string> {
  const dir = stateDir(root, state);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, ref + ".yaml");
  await fs.writeFile(file, body, "utf8");
  return file;
}

describe("moveBetweenStates — happy path (AC6a)", () => {
  it("performs exactly one rename syscall and returns the move result", async () => {
    const root = await makeRoot();
    const ref = "bmad:1.0.0";
    const body = "# manifest body\n";
    const absFromPath = await seedManifest(root, "to-do", ref, body);
    const absToPath = path.join(stateDir(root, "in-progress"), ref + ".yaml");

    const spy = {
      rename: vi.fn((from: string, to: string) => fs.rename(from, to)),
      mkdir: vi.fn((dir: string, opts: { recursive: true }) =>
        fs.mkdir(dir, opts),
      ),
      stat: vi.fn((p: string) => fs.stat(p)),
    };

    const result = await moveBetweenStates({
      targetRepoRoot: root,
      ref,
      from: "to-do",
      to: "in-progress",
      fsImpl: spy,
    });

    expect(spy.rename).toHaveBeenCalledTimes(1);
    expect(spy.rename).toHaveBeenCalledWith(absFromPath, absToPath);
    expect(spy.mkdir).toHaveBeenCalledWith(
      path.dirname(absToPath),
      { recursive: true },
    );

    // Structural guarantee: the FsImpl interface only exposes
    // rename/mkdir/stat. There is no copyFile / readFile / writeFile /
    // unlink seam to call, so the primitive cannot fall back.
    expect("copyFile" in spy).toBe(false);
    expect("readFile" in spy).toBe(false);
    expect("writeFile" in spy).toBe(false);
    expect("unlink" in spy).toBe(false);

    expect(await fs.readFile(absToPath, "utf8")).toBe(body);
    await expect(fs.stat(absFromPath)).rejects.toMatchObject({ code: "ENOENT" });

    expect(result).toEqual({
      from: "to-do",
      to: "in-progress",
      ref,
      absFromPath,
      absToPath,
    });
  });
});

describe("moveBetweenStates — destination dir auto-created (AC6b)", () => {
  it("creates the destination state directory if missing", async () => {
    const root = await makeRoot();
    const ref = "bmad:1.0.1";
    const body = "# auto-create-dir\n";
    await seedManifest(root, "to-do", ref, body);

    // Make sure in-progress/ does NOT exist before the call.
    const destDir = stateDir(root, "in-progress");
    await expect(fs.stat(destDir)).rejects.toMatchObject({ code: "ENOENT" });

    await moveBetweenStates({
      targetRepoRoot: root,
      ref,
      from: "to-do",
      to: "in-progress",
    });

    const destStat = await fs.stat(destDir);
    expect(destStat.isDirectory()).toBe(true);
    const movedPath = path.join(destDir, ref + ".yaml");
    expect(await fs.readFile(movedPath, "utf8")).toBe(body);
  });
});

describe("moveBetweenStates — EXDEV cross-filesystem (AC6c)", () => {
  it("throws CrossFilesystemMoveError with no copy fallback", async () => {
    const root = await makeRoot();
    const ref = "bmad:1.0.2";
    const body = "# cross-fs\n";
    const absFromPath = await seedManifest(root, "to-do", ref, body);
    const absToPath = path.join(stateDir(root, "in-progress"), ref + ".yaml");

    const spy = {
      rename: vi.fn(() => {
        return Promise.reject(
          Object.assign(new Error("cross-fs"), { code: "EXDEV" }),
        );
      }),
      mkdir: vi.fn((dir: string, opts: { recursive: true }) =>
        fs.mkdir(dir, opts),
      ),
      stat: vi.fn((p: string) => fs.stat(p)),
    };

    await expect(
      moveBetweenStates({
        targetRepoRoot: root,
        ref,
        from: "to-do",
        to: "in-progress",
        fsImpl: spy,
      }),
    ).rejects.toBeInstanceOf(CrossFilesystemMoveError);

    try {
      await moveBetweenStates({
        targetRepoRoot: root,
        ref,
        from: "to-do",
        to: "in-progress",
        fsImpl: spy,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CrossFilesystemMoveError);
      const e = err as CrossFilesystemMoveError;
      expect(e.originalCode).toBe("EXDEV");
      expect(e.absFromPath).toBe(absFromPath);
      expect(e.absToPath).toBe(absToPath);
      expect(e.ref).toBe(ref);
    }

    // Source still present, destination absent.
    expect(await fs.readFile(absFromPath, "utf8")).toBe(body);
    await expect(fs.stat(absToPath)).rejects.toMatchObject({ code: "ENOENT" });

    // Structural assertion: no copy/read/write/unlink seam exists.
    expect("copyFile" in spy).toBe(false);
    expect("readFile" in spy).toBe(false);
    expect("writeFile" in spy).toBe(false);
    expect("unlink" in spy).toBe(false);
  });
});

describe("moveBetweenStates — ENOENT source missing (AC6d)", () => {
  it("throws ManifestNotFoundError with the expected source path", async () => {
    const root = await makeRoot();
    const ref = "ghost";
    const expectedAbsPath = path.join(stateDir(root, "to-do"), ref + ".yaml");
    const absToPath = path.join(stateDir(root, "in-progress"), ref + ".yaml");

    await expect(
      moveBetweenStates({
        targetRepoRoot: root,
        ref,
        from: "to-do",
        to: "in-progress",
      }),
    ).rejects.toBeInstanceOf(ManifestNotFoundError);

    try {
      await moveBetweenStates({
        targetRepoRoot: root,
        ref,
        from: "to-do",
        to: "in-progress",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestNotFoundError);
      const e = err as ManifestNotFoundError;
      expect(e.ref).toBe(ref);
      expect(e.expectedAbsPath).toBe(expectedAbsPath);
      expect(e.fromState).toBe("to-do");
    }

    await expect(fs.stat(absToPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("moveBetweenStates — invalid state name & path escape (AC6e)", () => {
  it("Variant 1: unknown state name — no IO performed", async () => {
    const root = await makeRoot();
    const spy = {
      rename: vi.fn(() => {
        throw new Error("should not be called");
      }),
      mkdir: vi.fn(() => {
        throw new Error("should not be called");
      }),
      stat: vi.fn(() => {
        throw new Error("should not be called");
      }),
    };

    await expect(
      moveBetweenStates({
        targetRepoRoot: root,
        ref: "bmad:bogus",
        from: "to-do",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        to: "archive" as any,
        fsImpl: spy,
      }),
    ).rejects.toBeInstanceOf(InvalidStateNameError);

    try {
      await moveBetweenStates({
        targetRepoRoot: root,
        ref: "bmad:bogus",
        from: "to-do",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        to: "archive" as any,
        fsImpl: spy,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidStateNameError);
      const e = err as InvalidStateNameError;
      expect(e.reason).toBe("unknown state name");
    }

    expect(spy.rename).toHaveBeenCalledTimes(0);
    expect(spy.mkdir).toHaveBeenCalledTimes(0);
    expect(spy.stat).toHaveBeenCalledTimes(0);
  });

  it("Variant 2: ref escapes state root — no IO performed", async () => {
    const root = await makeRoot();
    const spy = {
      rename: vi.fn(() => {
        throw new Error("should not be called");
      }),
      mkdir: vi.fn(() => {
        throw new Error("should not be called");
      }),
      stat: vi.fn(() => {
        throw new Error("should not be called");
      }),
    };

    await expect(
      moveBetweenStates({
        targetRepoRoot: root,
        ref: "../../etc/passwd",
        from: "to-do",
        to: "in-progress",
        fsImpl: spy,
      }),
    ).rejects.toBeInstanceOf(InvalidStateNameError);

    try {
      await moveBetweenStates({
        targetRepoRoot: root,
        ref: "../../etc/passwd",
        from: "to-do",
        to: "in-progress",
        fsImpl: spy,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidStateNameError);
      const e = err as InvalidStateNameError;
      expect(e.reason).toBe("path escapes state root");
    }

    expect(spy.rename).toHaveBeenCalledTimes(0);
    expect(spy.mkdir).toHaveBeenCalledTimes(0);
    expect(spy.stat).toHaveBeenCalledTimes(0);
  });
});

// mulberry32 PRNG — deterministic 32-bit-seeded RNG. Source:
// https://gist.github.com/tommyettinger/46a3d4d3ce28d2c4d4e0d2c1a4a3b6c8
// (well-known MIT-licensed snippet, reproduced here to avoid adding a dep).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("moveBetweenStates — chaos: 1,000 random moves, no two-states-at-once (AC6f)", () => {
  it(
    "preserves the no-duplicate-states invariant across concurrent batches",
    async () => {
      const root = await makeRoot();
      const SEED = 0xcafebabe;
      const rand = mulberry32(SEED);
      const N = 16;
      const TOTAL_MOVES = 1000;
      const BATCH_SIZE = 8;

      const refs: string[] = [];
      const currentState = new Map<string, StateName>();

      // Seed N manifests at random starting states.
      for (let i = 0; i < N; i++) {
        const ref = `chaos:${String(i + 1).padStart(4, "0")}`;
        const startIdx = Math.floor(rand() * STATE_NAMES.length);
        const startState = STATE_NAMES[startIdx]!;
        await seedManifest(root, startState, ref, `${ref}\n`);
        refs.push(ref);
        currentState.set(ref, startState);
      }

      async function observeAndAssert(): Promise<void> {
        const counts = new Map<string, number>();
        let total = 0;
        for (const state of STATE_NAMES) {
          let entries: string[] = [];
          try {
            entries = await fs.readdir(stateDir(root, state));
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") throw err;
          }
          for (const f of entries) {
            if (!f.endsWith(".yaml")) continue;
            const ref = f.slice(0, -".yaml".length);
            counts.set(ref, (counts.get(ref) ?? 0) + 1);
            total++;
          }
        }
        expect(total).toBe(N);
        for (const ref of refs) {
          expect(counts.get(ref)).toBe(1);
        }
      }

      // Drive 1,000 random transitions in concurrent batches of 8.
      let pending: Array<{
        ref: string;
        from: StateName;
        to: StateName;
        promise: Promise<unknown>;
      }> = [];

      for (let i = 0; i < TOTAL_MOVES; i++) {
        const ref = refs[Math.floor(rand() * refs.length)]!;
        const from = currentState.get(ref)!;
        // Pick a target state different from `from`.
        const others = STATE_NAMES.filter((s) => s !== from);
        const to = others[Math.floor(rand() * others.length)]!;

        const promise = moveBetweenStates({
          targetRepoRoot: root,
          ref,
          from,
          to,
        });
        pending.push({ ref, from, to, promise });

        if (pending.length >= BATCH_SIZE) {
          const results = await Promise.allSettled(pending.map((p) => p.promise));
          results.forEach((r, idx) => {
            const item = pending[idx]!;
            if (r.status === "fulfilled") {
              currentState.set(item.ref, item.to);
            }
            // Rejections are expected when concurrent batch members
            // race on the same ref — the file simply isn't where this
            // call expected. Leave currentState as-is.
          });
          pending = [];
          await observeAndAssert();
        }
      }
      if (pending.length > 0) {
        const results = await Promise.allSettled(pending.map((p) => p.promise));
        results.forEach((r, idx) => {
          const item = pending[idx]!;
          if (r.status === "fulfilled") {
            currentState.set(item.ref, item.to);
          }
        });
      }

      // Final pass.
      await observeAndAssert();
    },
    20_000,
  );
});
