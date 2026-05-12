import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commitAll, handleStop } from "../src/stop.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function makeRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stop-hook-"));
  cleanups.push(async () => fs.rm(root, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: root });
  // Seed an initial commit so `git rev-parse HEAD` always works.
  await fs.writeFile(path.join(root, "seed"), "x", "utf8");
  spawnSync("git", ["add", "-A"], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd: root });
  return root;
}

async function makeSprintRepo(sprintYaml: string): Promise<string> {
  const root = await makeRepo();
  await fs.writeFile(path.join(root, "sprint-status.yaml"), sprintYaml, "utf8");
  return root;
}

describe("handleStop", () => {
  it("noop when no sprint-status.yaml", async () => {
    const root = await makeRepo();
    const r = await handleStop({ cwd: root });
    expect(r.action).toBe("noop");
  });

  it("noop when nothing in_progress", async () => {
    const root = await makeSprintRepo(
      `sprint_id: t
stories:
  - id: A
    title: a
    status: ready
    depends_on: []
    acceptance_criteria: { checks: [] }
    orchestrator: {}
`,
    );
    const r = await handleStop({ cwd: root });
    expect(r.action).toBe("noop");
  });

  it("noop when multiple in_progress (ambiguous)", async () => {
    const root = await makeSprintRepo(
      `sprint_id: t
stories:
  - id: A
    title: a
    status: in_progress
    depends_on: []
    acceptance_criteria: { checks: [] }
    orchestrator: { claimed_by: x }
  - id: B
    title: b
    status: in_progress
    depends_on: []
    acceptance_criteria: { checks: [] }
    orchestrator: { claimed_by: y }
`,
    );
    const r = await handleStop({ cwd: root });
    expect(r.action).toBe("noop");
  });

  it("commits and marks complete when one in_progress passes AC", async () => {
    const root = await makeSprintRepo(
      `sprint_id: t
stories:
  - id: S1
    title: ship the thing
    status: in_progress
    depends_on: []
    acceptance_criteria: { checks: [] }
    orchestrator: { claimed_by: me }
`,
    );
    // Stage a change so commitAll has something to commit
    await fs.writeFile(path.join(root, "thing.txt"), "ship", "utf8");
    const r = await handleStop({ cwd: root });
    expect(r.action).toBe("completed");
    if (r.action === "completed") expect(r.storyId).toBe("S1");
  });

  it("marks failed when AC fails", async () => {
    const root = await makeSprintRepo(
      `sprint_id: t
stories:
  - id: S1
    title: nope
    status: in_progress
    depends_on: []
    acceptance_criteria:
      checks:
        - type: shell
          cmd: exit 1
          expect_exit: 0
    orchestrator: { claimed_by: me }
`,
    );
    const r = await handleStop({ cwd: root });
    expect(r.action).toBe("failed");
  });
});

describe("commitAll", () => {
  it("commits changes and returns the SHA", async () => {
    const root = await makeRepo();
    await fs.writeFile(path.join(root, "new.txt"), "hello", "utf8");
    const sha = await commitAll(root, "feat(S1): hello");
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
    const log = spawnSync("git", ["log", "-1", "--pretty=%B"], { cwd: root, encoding: "utf8" });
    expect(log.stdout).toContain("feat(S1): hello");
    expect(log.stdout).toContain("Co-authored-by: Claude");
  });

  it("returns null with no changes to commit", async () => {
    const root = await makeRepo();
    const sha = await commitAll(root, "noop");
    expect(sha).toBeNull();
  });
});
