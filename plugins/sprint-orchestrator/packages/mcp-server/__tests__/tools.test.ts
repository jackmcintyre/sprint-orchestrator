import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { baseSprint, makeTempProject } from "./fixtures.js";

import { getSprintStatus } from "../src/tools/get-sprint-status.js";
import { getSprintReport } from "../src/tools/get-sprint-report.js";
import { getReadyStories } from "../src/tools/get-ready-stories.js";
import { getStoryContext } from "../src/tools/get-story-context.js";
import { claimStory } from "../src/tools/claim-story.js";
import { markStoryComplete } from "../src/tools/mark-story-complete.js";
import { markStoryFailed } from "../src/tools/mark-story-failed.js";
import { validateAcceptanceCriteria } from "../src/tools/validate-acceptance-criteria.js";
import { releaseStaleClaims } from "../src/tools/release-stale-claims.js";
import { prepareStoryBranch } from "../src/tools/prepare-story-branch.js";
import { spawnSync } from "node:child_process";
import {
  AcceptanceFailedError,
  ClaimConflictError,
  InvalidStateTransitionError,
  StoryNotFoundError,
} from "../src/lib/errors.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(initial = baseSprint) {
  const tmp = await makeTempProject(JSON.parse(JSON.stringify(initial)));
  cleanups.push(tmp.cleanup);
  return tmp;
}

describe("getSprintStatus", () => {
  it("returns the parsed file", async () => {
    const { ctx } = await setup();
    const state = await getSprintStatus(ctx);
    expect(state.stories.map((s) => s.id)).toEqual(["S1", "S2", "S3"]);
  });
});

describe("getReadyStories", () => {
  it("returns only ready stories whose deps are done", async () => {
    const { ctx } = await setup();
    const ready = await getReadyStories(ctx);
    expect(ready.map((s) => s.id)).toEqual(["S1"]); // S2 depends on S1 which is ready (not done)
  });

  it("includes a story when all its deps become done", async () => {
    const variant = {
      ...baseSprint,
      stories: baseSprint.stories.map((s) =>
        s.id === "S1"
          ? { ...s, status: "done", orchestrator: { completed_at: "2026-05-12T08:00:00Z" } }
          : s,
      ),
    };
    const { ctx } = await setup(variant as unknown as typeof baseSprint);
    const ready = await getReadyStories(ctx);
    expect(ready.map((s) => s.id)).toEqual(["S2"]);
  });

  it("auto-promotes a backlog story whose deps are all done and persists the change", async () => {
    const variant = {
      sprint_id: "promote-fixture",
      stories: [
        {
          id: "D1",
          title: "done dep",
          status: "done",
          depends_on: [],
          acceptance_criteria: { checks: [] },
          orchestrator: { completed_at: "2026-05-12T08:00:00Z" },
        },
        {
          id: "B1",
          title: "backlog with done dep",
          status: "backlog",
          depends_on: ["D1"],
          acceptance_criteria: { checks: [] },
          orchestrator: {},
        },
      ],
    };
    const { ctx } = await setup(variant as unknown as typeof baseSprint);
    const ready = await getReadyStories(ctx);
    expect(ready.map((s) => s.id)).toEqual(["B1"]);
    // Persisted: a second call sees status=ready on disk too.
    const state = await getSprintStatus(ctx);
    expect(state.stories.find((s) => s.id === "B1")!.status).toBe("ready");
  });

  it("does not promote a backlog story whose deps are not all done", async () => {
    const variant = {
      sprint_id: "no-promote",
      stories: [
        {
          id: "R1",
          title: "ready dep",
          status: "ready",
          depends_on: [],
          acceptance_criteria: { checks: [] },
          orchestrator: {},
        },
        {
          id: "B1",
          title: "backlog waiting",
          status: "backlog",
          depends_on: ["R1"],
          acceptance_criteria: { checks: [] },
          orchestrator: {},
        },
      ],
    };
    const { ctx } = await setup(variant as unknown as typeof baseSprint);
    const ready = await getReadyStories(ctx);
    expect(ready.map((s) => s.id)).toEqual(["R1"]);
    const state = await getSprintStatus(ctx);
    expect(state.stories.find((s) => s.id === "B1")!.status).toBe("backlog");
  });

  it("does not promote a backlog story whose declared dep does not exist", async () => {
    const variant = {
      sprint_id: "ghost-dep",
      stories: [
        {
          id: "B1",
          title: "backlog with ghost dep",
          status: "backlog",
          depends_on: ["ghost"],
          acceptance_criteria: { checks: [] },
          orchestrator: {},
        },
      ],
    };
    const { ctx } = await setup(variant as unknown as typeof baseSprint);
    expect(await getReadyStories(ctx)).toEqual([]);
    const state = await getSprintStatus(ctx);
    expect(state.stories.find((s) => s.id === "B1")!.status).toBe("backlog");
  });

  it("excludes a story whose declared dep does not exist", async () => {
    const variant = {
      ...baseSprint,
      stories: [
        {
          id: "X1",
          title: "missing dep",
          status: "ready",
          depends_on: ["ghost"],
          acceptance_criteria: { checks: [] },
          orchestrator: {},
        },
      ],
    };
    const { ctx } = await setup(variant as unknown as typeof baseSprint);
    expect(await getReadyStories(ctx)).toEqual([]);
  });
});

describe("claimStory", () => {
  it("transitions ready → in_progress on the first claimant", async () => {
    const { ctx } = await setup();
    const res = await claimStory(ctx, "S1", "agent-a");
    expect(res.claimed).toBe(true);
    const state = await getSprintStatus(ctx);
    const s1 = state.stories.find((s) => s.id === "S1")!;
    expect(s1.status).toBe("in_progress");
    expect(s1.orchestrator.claimed_by).toBe("agent-a");
  });

  it("rejects the second claimant in a concurrent race", async () => {
    const { ctx } = await setup();
    const [a, b] = await Promise.all([claimStory(ctx, "S1", "A"), claimStory(ctx, "S1", "B")]);
    const winners = [a, b].filter((r) => r.claimed);
    const losers = [a, b].filter((r) => !r.claimed);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(losers[0]!.holder).toMatch(/^(A|B)$/);
  });

  it("throws StoryNotFoundError on unknown story", async () => {
    const { ctx } = await setup();
    await expect(claimStory(ctx, "nope", "A")).rejects.toBeInstanceOf(StoryNotFoundError);
  });
});

describe("markStoryComplete", () => {
  it("transitions in_progress → done when caller is the holder and AC passes", async () => {
    const { ctx } = await setup();
    await claimStory(ctx, "S1", "agent-a");
    await markStoryComplete(ctx, "S1", "agent-a", "implemented", ["file.ts"]);
    const state = await getSprintStatus(ctx);
    const s1 = state.stories.find((s) => s.id === "S1")!;
    expect(s1.status).toBe("done");
    expect(s1.orchestrator.summary).toBe("implemented");
  });

  it("rejects if caller is not the claim holder", async () => {
    const { ctx } = await setup();
    await claimStory(ctx, "S1", "agent-a");
    await expect(markStoryComplete(ctx, "S1", "other", "x")).rejects.toBeInstanceOf(
      ClaimConflictError,
    );
  });

  it("rejects if story is not in_progress", async () => {
    const { ctx } = await setup();
    await expect(markStoryComplete(ctx, "S1", "agent-a", "x")).rejects.toBeInstanceOf(
      InvalidStateTransitionError,
    );
  });

  it("rejects if acceptance criteria fail", async () => {
    const variant = {
      ...baseSprint,
      stories: baseSprint.stories.map((s) =>
        s.id === "S1"
          ? { ...s, acceptance_criteria: { checks: [{ type: "shell", cmd: "exit 1" }] } }
          : s,
      ),
    };
    const { ctx } = await setup(variant as unknown as typeof baseSprint);
    await claimStory(ctx, "S1", "agent-a");
    await expect(markStoryComplete(ctx, "S1", "agent-a", "x")).rejects.toBeInstanceOf(
      AcceptanceFailedError,
    );
  });
});

describe("markStoryFailed", () => {
  it("transitions to failed with reason", async () => {
    const { ctx } = await setup();
    await markStoryFailed(ctx, "S1", "compiler exploded");
    const state = await getSprintStatus(ctx);
    const s1 = state.stories.find((s) => s.id === "S1")!;
    expect(s1.status).toBe("failed");
    expect(s1.orchestrator.last_failure_reason).toBe("compiler exploded");
  });
});

describe("validateAcceptanceCriteria", () => {
  it("returns passed=true when all checks pass", async () => {
    const { ctx } = await setup();
    const r = await validateAcceptanceCriteria(ctx, "S1"); // S1 has empty checks
    expect(r.passed).toBe(true);
    expect(r.results).toEqual([]);
  });

  it("runs shell, file_exists and regex checks", async () => {
    const variant = {
      ...baseSprint,
      stories: [
        {
          ...baseSprint.stories[0]!,
          acceptance_criteria: {
            checks: [
              { type: "shell", cmd: "echo hello" },
              { type: "file_exists", path: "sprint-status.yaml" },
              { type: "regex", cmd: "echo banana", pattern: "ban+ana" },
            ],
          },
        },
      ],
    };
    const { ctx } = await setup(variant as unknown as typeof baseSprint);
    const r = await validateAcceptanceCriteria(ctx, "S1");
    expect(r.passed).toBe(true);
    expect(r.results.map((x) => x.type)).toEqual(["shell", "file_exists", "regex"]);
  });

  it("regex check fails when cmd exits non-zero even if stderr matches the pattern", async () => {
    // Regression: `cat hello.txt` on a missing file prints
    //   `cat: hello.txt: No such file or directory`
    // which contains the substring "hello" — without the exit-code gate the
    // regex check would falsely report passed.
    const variant = {
      ...baseSprint,
      stories: [
        {
          ...baseSprint.stories[0]!,
          acceptance_criteria: {
            checks: [{ type: "regex", cmd: "cat hello-not-real.txt", pattern: "hello" }],
          },
        },
      ],
    };
    const { ctx } = await setup(variant as unknown as typeof baseSprint);
    const r = await validateAcceptanceCriteria(ctx, "S1");
    expect(r.passed).toBe(false);
    expect(r.results[0]!.passed).toBe(false);
  });

  it("reports per-check failures", async () => {
    const variant = {
      ...baseSprint,
      stories: [
        {
          ...baseSprint.stories[0]!,
          acceptance_criteria: {
            checks: [
              { type: "shell", cmd: "exit 1" },
              { type: "file_exists", path: "does/not/exist" },
              { type: "regex", cmd: "echo hi", pattern: "nope" },
            ],
          },
        },
      ],
    };
    const { ctx } = await setup(variant as unknown as typeof baseSprint);
    const r = await validateAcceptanceCriteria(ctx, "S1");
    expect(r.passed).toBe(false);
    expect(r.results.every((c) => !c.passed)).toBe(true);
  });
});

describe("releaseStaleClaims", () => {
  it("releases only claims older than the threshold", async () => {
    const oldClaim = new Date(Date.now() - 60 * 60_000).toISOString();
    const freshClaim = new Date().toISOString();
    const variant = {
      ...baseSprint,
      stories: [
        {
          id: "OLD",
          title: "old",
          status: "in_progress",
          depends_on: [],
          acceptance_criteria: { checks: [] },
          orchestrator: { claimed_by: "ghost", claimed_at: oldClaim },
        },
        {
          id: "NEW",
          title: "new",
          status: "in_progress",
          depends_on: [],
          acceptance_criteria: { checks: [] },
          orchestrator: { claimed_by: "alive", claimed_at: freshClaim },
        },
      ],
    };
    const { ctx } = await setup(variant as unknown as typeof baseSprint);
    const released = await releaseStaleClaims(ctx, 30);
    expect(released).toEqual(["OLD"]);
    const state = await getSprintStatus(ctx);
    expect(state.stories.find((s) => s.id === "OLD")!.status).toBe("ready");
    expect(state.stories.find((s) => s.id === "NEW")!.status).toBe("in_progress");
  });
});

describe("getStoryContext", () => {
  it("returns story plus resolved doc paths when configured", async () => {
    const { ctx } = await setup();
    // Create BMAD-like layout so auto-detect sets config
    await fs.mkdir(path.join(ctx.projectRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(ctx.projectRoot, "docs/prd.md"), "# prd", "utf8");
    await fs.writeFile(path.join(ctx.projectRoot, "docs/architecture.md"), "# arch", "utf8");

    const result = await getStoryContext(ctx, "S1");
    expect(result.story.id).toBe("S1");
    expect(result.contextPaths.prd).toMatch(/docs\/prd\.md$/);
    expect(result.contextPaths.architecture).toMatch(/docs\/architecture\.md$/);
  });

  it("returns empty contextPaths when no docs are detected", async () => {
    const { ctx } = await setup();
    const result = await getStoryContext(ctx, "S1");
    expect(result.contextPaths).toEqual({});
  });
});

describe("getSprintReport", () => {
  const fullSpread = {
    sprint_id: "report-fixture",
    stories: [
      {
        id: "B1",
        title: "Backlog item",
        status: "backlog",
        depends_on: [],
        acceptance_criteria: { checks: [] },
        orchestrator: {},
      },
      {
        id: "R1",
        title: "Ready item",
        status: "ready",
        depends_on: [],
        acceptance_criteria: { checks: [] },
        orchestrator: {},
      },
      {
        id: "P1",
        title: "Work in progress",
        status: "in_progress",
        depends_on: [],
        acceptance_criteria: { checks: [] },
        orchestrator: { claimed_by: "dev-1", claimed_at: "2026-05-12T08:00:00Z" },
      },
      {
        id: "D1",
        title: "Already done",
        status: "done",
        depends_on: [],
        acceptance_criteria: { checks: [] },
        orchestrator: { completed_at: "2026-05-12T09:00:00Z", summary: "shipped" },
      },
      {
        id: "X1",
        title: "Failed story",
        status: "failed",
        depends_on: [],
        acceptance_criteria: { checks: [] },
        orchestrator: { last_failure_reason: "dep missing" },
      },
      {
        id: "K1",
        title: "Blocked on external",
        status: "blocked",
        depends_on: [],
        acceptance_criteria: { checks: [] },
        orchestrator: { last_failure_reason: "waiting on vendor" },
      },
    ],
  };

  it("counts every status and renders every story", async () => {
    const { ctx } = await setup(fullSpread as unknown as typeof baseSprint);
    const report = await getSprintReport(ctx);

    expect(report.counts).toEqual({
      backlog: 1,
      ready: 1,
      in_progress: 1,
      done: 1,
      failed: 1,
      blocked: 1,
    });
    expect(report.stories.map((s) => s.id).sort()).toEqual(["B1", "D1", "K1", "P1", "R1", "X1"]);
    for (const story of fullSpread.stories) {
      expect(report.rendered).toContain(story.id);
      expect(report.rendered).toContain(story.title);
    }
    expect(report.rendered).toContain("report-fixture");
  });

  it("renders failed and blocked as separate groups", async () => {
    const { ctx } = await setup(fullSpread as unknown as typeof baseSprint);
    const report = await getSprintReport(ctx);
    expect(report.rendered).toContain("[failed] (1)");
    expect(report.rendered).toContain("[blocked] (1)");
  });

  it("surfaces lastFailure for failed stories", async () => {
    const { ctx } = await setup(fullSpread as unknown as typeof baseSprint);
    const report = await getSprintReport(ctx);
    const failed = report.stories.find((s) => s.id === "X1");
    expect(failed?.lastFailure).toBe("dep missing");
    expect(report.rendered).toContain("dep missing");
  });

  it("includes summary for done stories and omits empty optional fields", async () => {
    const { ctx } = await setup(fullSpread as unknown as typeof baseSprint);
    const report = await getSprintReport(ctx);
    const done = report.stories.find((s) => s.id === "D1");
    expect(done?.summary).toBe("shipped");
    expect(done?.lastFailure).toBeUndefined();
    const ready = report.stories.find((s) => s.id === "R1");
    expect(ready?.summary).toBeUndefined();
    expect(ready?.lastFailure).toBeUndefined();
  });
});

function git(cwd: string, args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

describe("prepareStoryBranch / default_base schema check", () => {
  it("refuses with reason=default_base-stale when main lacks schema_version", async () => {
    const initial = {
      sprint_id: "stale-base-unit",
      schema_version: 1,
      stories: [
        {
          id: "A",
          title: "Some story",
          status: "ready",
          depends_on: [],
          acceptance_criteria: { checks: [] },
          orchestrator: {},
        },
      ],
    };
    const { ctx } = await setup(initial as unknown as typeof baseSprint);
    // Bootstrap a real git repo at projectRoot, commit current state on main,
    // strip schema_version on main, branch off to a feature branch and put
    // schema_version back. This mirrors the e2e fixture but stays inside the
    // unit-test temp dir.
    const root = ctx.projectRoot;
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "unit@example.com"]);
    git(root, ["config", "user.name", "Unit Test"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    git(root, ["add", "sprint-status.yaml"]);
    const c1 = git(root, ["commit", "-q", "-m", "initial"]);
    expect(c1.status).toBe(0);

    // Drop schema_version on main.
    const fsMod = await import("node:fs");
    const raw = fsMod.readFileSync(ctx.sprintStatusPath, "utf8");
    fsMod.writeFileSync(ctx.sprintStatusPath, raw.replace(/^schema_version:.*\n/m, ""), "utf8");
    git(root, ["add", "sprint-status.yaml"]);
    git(root, ["commit", "-q", "-m", "main: drop schema_version"]);

    // Feature branch with schema_version restored.
    git(root, ["checkout", "-q", "-b", "feat/x"]);
    fsMod.writeFileSync(ctx.sprintStatusPath, raw, "utf8");
    git(root, ["add", "sprint-status.yaml"]);
    git(root, ["commit", "-q", "-m", "feat: schema_version"]);

    // Configure pr_per_story=true, default_base=main.
    fsMod.mkdirSync(path.dirname(ctx.configPath), { recursive: true });
    fsMod.writeFileSync(
      ctx.configPath,
      [
        "sprintStatusPath: sprint-status.yaml",
        "autoDetected: false",
        'layout: "custom"',
        "pr_per_story: true",
        'default_base: "main"',
        "",
      ].join("\n"),
      "utf8",
    );

    const headBefore = git(root, ["rev-parse", "HEAD"]).stdout.trim();
    const branchBefore = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();

    const result = await prepareStoryBranch(ctx, "A", "agent-unit");
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("default_base-stale");
    expect(result.branch).toBeNull();
    expect(result.message).toMatch(/default_base/);

    const headAfter = git(root, ["rev-parse", "HEAD"]).stdout.trim();
    const branchAfter = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
    expect(headAfter).toBe(headBefore);
    expect(branchAfter).toBe(branchBefore);
  });

  it("does not run the schema check when default_base == current HEAD", async () => {
    const initial = {
      sprint_id: "head-equals-base",
      schema_version: 1,
      stories: [
        {
          id: "A",
          title: "Some story",
          status: "ready",
          depends_on: [],
          acceptance_criteria: { checks: [] },
          orchestrator: {},
        },
      ],
    };
    const { ctx } = await setup(initial as unknown as typeof baseSprint);
    const root = ctx.projectRoot;
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "unit@example.com"]);
    git(root, ["config", "user.name", "Unit Test"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    git(root, ["add", "sprint-status.yaml"]);
    git(root, ["commit", "-q", "-m", "initial"]);

    const fsMod = await import("node:fs");
    fsMod.mkdirSync(path.dirname(ctx.configPath), { recursive: true });
    fsMod.writeFileSync(
      ctx.configPath,
      [
        "sprintStatusPath: sprint-status.yaml",
        "autoDetected: false",
        'layout: "custom"',
        "pr_per_story: true",
        'default_base: "main"',
        "",
      ].join("\n"),
      "utf8",
    );

    // HEAD is main here, so the stale-base check must short-circuit and a
    // per-story branch should be created.
    const result = await prepareStoryBranch(ctx, "A", "agent-unit");
    expect(result.skipped).toBe(false);
    expect(result.branch).toBe("a-some-story");
    expect(result.reason).toBeUndefined();
  });

  it("roots from the last completed dependency's branch tip when chainable", async () => {
    const initial = {
      sprint_id: "chain-base",
      schema_version: 1,
      stories: [
        {
          id: "A",
          title: "First done story",
          status: "done",
          depends_on: [],
          acceptance_criteria: { checks: [] },
          orchestrator: {
            branch: "a-first-done-story",
            completed_at: "2026-05-12T08:00:00Z",
          },
        },
        {
          id: "B",
          title: "Depends on A",
          status: "ready",
          depends_on: ["A"],
          acceptance_criteria: { checks: [] },
          orchestrator: {},
        },
      ],
    };
    const { ctx } = await setup(initial as unknown as typeof baseSprint);
    const root = ctx.projectRoot;
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "unit@example.com"]);
    git(root, ["config", "user.name", "Unit Test"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    git(root, ["add", "sprint-status.yaml"]);
    git(root, ["commit", "-q", "-m", "initial"]);

    // Create A's branch with an extra commit so we can verify B is rooted
    // from A's tip (which is ahead of main).
    git(root, ["checkout", "-q", "-b", "a-first-done-story"]);
    const fsMod = await import("node:fs");
    fsMod.writeFileSync(path.join(root, "from-a.txt"), "a\n", "utf8");
    git(root, ["add", "from-a.txt"]);
    git(root, ["commit", "-q", "-m", "A: marker commit"]);
    const aTip = git(root, ["rev-parse", "HEAD"]).stdout.trim();
    // Go back to main so prepareStoryBranch has to actively choose A's tip.
    git(root, ["checkout", "-q", "main"]);

    fsMod.mkdirSync(path.dirname(ctx.configPath), { recursive: true });
    fsMod.writeFileSync(
      ctx.configPath,
      [
        "sprintStatusPath: sprint-status.yaml",
        "autoDetected: false",
        'layout: "custom"',
        "pr_per_story: true",
        'default_base: "main"',
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await prepareStoryBranch(ctx, "B", "agent-unit");
    expect(result.skipped).toBe(false);
    expect(result.branch).toBe("b-depends-on-a");

    // B's HEAD must equal A's tip (we haven't committed anything on B yet).
    const bHead = git(root, ["rev-parse", "HEAD"]).stdout.trim();
    expect(bHead).toBe(aTip);

    // State must record the chosen base.
    const stateRaw = fsMod.readFileSync(ctx.sprintStatusPath, "utf8");
    expect(stateRaw).toMatch(/base_branch:\s*a-first-done-story/);
    expect(stateRaw).not.toMatch(/base_branch_fallback_reason/);
  });

  it("falls back to default_base and records reason when a dep lacks orchestrator.branch", async () => {
    const initial = {
      sprint_id: "chain-fallback",
      schema_version: 1,
      stories: [
        {
          id: "A",
          title: "Done without branch",
          status: "done",
          depends_on: [],
          acceptance_criteria: { checks: [] },
          // No orchestrator.branch — simulates A having run with pr_per_story=false.
          orchestrator: { completed_at: "2026-05-12T08:00:00Z" },
        },
        {
          id: "B",
          title: "Depends on A",
          status: "ready",
          depends_on: ["A"],
          acceptance_criteria: { checks: [] },
          orchestrator: {},
        },
      ],
    };
    const { ctx } = await setup(initial as unknown as typeof baseSprint);
    const root = ctx.projectRoot;
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "unit@example.com"]);
    git(root, ["config", "user.name", "Unit Test"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    git(root, ["add", "sprint-status.yaml"]);
    git(root, ["commit", "-q", "-m", "initial"]);
    const mainTip = git(root, ["rev-parse", "HEAD"]).stdout.trim();

    const fsMod = await import("node:fs");
    fsMod.mkdirSync(path.dirname(ctx.configPath), { recursive: true });
    fsMod.writeFileSync(
      ctx.configPath,
      [
        "sprintStatusPath: sprint-status.yaml",
        "autoDetected: false",
        'layout: "custom"',
        "pr_per_story: true",
        'default_base: "main"',
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await prepareStoryBranch(ctx, "B", "agent-unit");
    expect(result.skipped).toBe(false);
    expect(result.branch).toBe("b-depends-on-a");
    // Branch should be rooted from main (the only commit so far).
    const bHead = git(root, ["rev-parse", "HEAD"]).stdout.trim();
    expect(bHead).toBe(mainTip);
    // State should record the fallback reason.
    const stateRaw = fsMod.readFileSync(ctx.sprintStatusPath, "utf8");
    expect(stateRaw).toMatch(/base_branch:\s*main/);
    expect(stateRaw).toMatch(/base_branch_fallback_reason:.*no orchestrator\.branch/);
  });
});
