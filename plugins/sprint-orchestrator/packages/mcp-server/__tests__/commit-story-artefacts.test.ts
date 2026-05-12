import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";

import { commitStoryArtefacts } from "../src/tools/commit-story-artefacts.js";
import { StoryNotFoundError } from "../src/lib/errors.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function makeRepoWithSprint(storyId = "S1", title = "Add a thing") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "commit-tool-"));
  cleanups.push(async () => fs.rm(root, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: root });
  const sprint = {
    sprint_id: "t",
    stories: [
      {
        id: storyId,
        title,
        status: "in_progress",
        depends_on: [],
        acceptance_criteria: { checks: [] },
        orchestrator: { claimed_by: "x" },
      },
    ],
  };
  const sprintStatusPath = path.join(root, "sprint-status.yaml");
  await fs.writeFile(sprintStatusPath, YAML.stringify(sprint), "utf8");
  await fs.writeFile(path.join(root, "seed"), "x", "utf8");
  spawnSync("git", ["add", "-A"], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd: root });
  const ctx = {
    projectRoot: root,
    sprintStatusPath,
    configPath: path.join(root, ".sprint-orchestrator", "config.yaml"),
  };
  return { root, ctx };
}

describe("commitStoryArtefacts", () => {
  it("commits unstaged changes and returns the SHA", async () => {
    const { root, ctx } = await makeRepoWithSprint("S1", "Add a thing");
    await fs.writeFile(path.join(root, "thing.txt"), "hello", "utf8");
    const r = await commitStoryArtefacts(ctx, "S1");
    expect(r.sha).toMatch(/^[a-f0-9]{40}$/);
    const log = spawnSync("git", ["log", "-1", "--pretty=%B"], { cwd: root, encoding: "utf8" });
    expect(log.stdout).toContain("feat(S1): Add a thing");
    expect(log.stdout).toContain("Co-authored-by: Claude");
  });

  it("returns { sha: null } when there is nothing to commit", async () => {
    const { ctx } = await makeRepoWithSprint();
    const r = await commitStoryArtefacts(ctx, "S1");
    expect(r.sha).toBeNull();
  });

  it("throws StoryNotFoundError for an unknown story", async () => {
    const { ctx } = await makeRepoWithSprint();
    await expect(commitStoryArtefacts(ctx, "ghost")).rejects.toBeInstanceOf(StoryNotFoundError);
  });
});
