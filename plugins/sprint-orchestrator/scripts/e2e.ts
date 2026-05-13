/* eslint-disable no-console */
/**
 * End-to-end harness for the sprint-orchestrator MCP server.
 *
 * Copies the tiny-sprint fixture into a temp git repo, drives the
 * orchestrator state machine through the full happy + failure paths,
 * and asserts post-conditions that the regression-fix stories must
 * satisfy.
 *
 * Usage:
 *   pnpm e2e                          # run all assertions
 *   pnpm e2e -- --grep "auto-promote" # only assertions whose name matches
 *
 * Exit code: 0 when every (filtered) assertion passes; 1 otherwise.
 *
 * NOTE: assertions are intentionally strict — many will fail until the
 * companion regression-fix stories land. That is by design.
 */
import { spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { claimStory } from "../packages/mcp-server/src/tools/claim-story.js";
import { commitStoryArtefacts } from "../packages/mcp-server/src/tools/commit-story-artefacts.js";
import { markStoryComplete } from "../packages/mcp-server/src/tools/mark-story-complete.js";
import { markStoryFailed } from "../packages/mcp-server/src/tools/mark-story-failed.js";
import { markStoryNeedsRework } from "../packages/mcp-server/src/tools/mark-story-needs-rework.js";
import { prepareStoryBranch } from "../packages/mcp-server/src/tools/prepare-story-branch.js";
import { recordStoryReopen } from "../packages/mcp-server/src/tools/record-story-reopen.js";
import { getReadyStories } from "../packages/mcp-server/src/tools/get-ready-stories.js";
import { lintSprint } from "../packages/mcp-server/src/tools/lint-sprint.js";
import { validateAcceptanceCriteria } from "../packages/mcp-server/src/tools/validate-acceptance-criteria.js";
import { type ToolContext } from "../packages/mcp-server/src/tools/context.js";
import { readSprintStatus } from "../packages/mcp-server/src/state/sprint-status.js";
import { appendRunLog } from "../packages/hooks/src/post-tool-use.js";
import { handleStop } from "../packages/hooks/src/stop.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(HERE, "..", "__fixtures__", "tiny-sprint");
const MCP_SERVER_DIR = path.resolve(HERE, "..", "packages", "mcp-server");
const MCP_SERVER_DIST_ENTRY = path.join(MCP_SERVER_DIR, "dist", "index.js");
const MCP_SERVER_DIST_GET_READY = path.join(
  MCP_SERVER_DIR,
  "dist",
  "tools",
  "get-ready-stories.js",
);

interface Assertion {
  name: string;
  run: () => void | Promise<void>;
}

interface AssertionOutcome {
  name: string;
  passed: boolean;
  error?: string;
}

interface CliArgs {
  grep?: string;
  keep?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--grep") {
      out.grep = argv[++i];
    } else if (a?.startsWith("--grep=")) {
      out.grep = a.slice("--grep=".length);
    } else if (a === "--keep") {
      out.keep = true;
    }
  }
  return out;
}

function git(cwd: string, args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

async function copyDir(src: string, dest: string): Promise<void> {
  // node 20 has fs.cp; use the recursive option.
  await fs.cp(src, dest, { recursive: true });
}

async function setupTempRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sprint-orch-e2e-"));
  await copyDir(FIXTURE_ROOT, root);
  // Drop a stray .DS_Store the fixture itself doesn't ship, to verify the
  // commit-story-artefacts tool doesn't slurp junk in real-world repos
  // whose .gitignore is incomplete.
  await fs.writeFile(path.join(root, ".DS_Store"), "junk\n", "utf8");

  const gitInit = git(root, ["init", "-q", "-b", "main"]);
  if (gitInit.status !== 0) throw new Error(`git init failed: ${gitInit.stderr}`);
  git(root, ["config", "user.email", "e2e@example.com"]);
  git(root, ["config", "user.name", "E2E Harness"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  // Ignore the .DS_Store we sprinkled in for the junk-files assertion;
  // the tool — not the harness — should keep it out of commits, so we
  // do NOT pre-stage it here. We only honor the fixture's own .gitignore.
  // First commit: just everything tracked initially.
  git(root, ["add", "-A", ":!.DS_Store"]);
  const commit = git(root, ["commit", "-q", "-m", "initial fixture import"]);
  if (commit.status !== 0) throw new Error(`initial commit failed: ${commit.stderr}`);
  return root;
}

/**
 * Ensure the mcp-server `dist/` build exists and is current. The published
 * MCP entry (per plugins/sprint-orchestrator/.mcp.json) is `dist/index.js`,
 * so any e2e assertion that wants to faithfully reproduce what the
 * orchestrator skill sees at runtime must talk to the dist build, not the
 * TypeScript source. We rebuild on every e2e run so a forgotten `pnpm build`
 * after a src edit does NOT silently mask a regression.
 */
function ensureDistBuilt(): void {
  const r = spawnSync("pnpm", ["--filter", "@sprint-orchestrator/mcp-server", "build"], {
    cwd: path.resolve(HERE, ".."),
    encoding: "utf8",
    stdio: "inherit",
  });
  if (r.status !== 0) {
    throw new Error(`mcp-server build failed (exit ${r.status ?? "?"})`);
  }
  if (!existsSync(MCP_SERVER_DIST_ENTRY) || !existsSync(MCP_SERVER_DIST_GET_READY)) {
    throw new Error(
      `mcp-server dist build missing expected files after build: ${MCP_SERVER_DIST_ENTRY}, ${MCP_SERVER_DIST_GET_READY}`,
    );
  }
}

/**
 * Dynamic import of the dist build of `getReadyStories`. Using a dynamic
 * import (a) keeps tsc happy when dist is absent at type-check time, and
 * (b) forces the read from the actual published entry the MCP server uses
 * at runtime — which is what makes this assertion a faithful repro of
 * stale-dist regressions.
 */
async function getReadyStoriesViaDist(ctx: ToolContext): Promise<{ id: string }[]> {
  const mod = (await import(MCP_SERVER_DIST_GET_READY)) as {
    getReadyStories: (c: ToolContext) => Promise<{ id: string }[]>;
  };
  return mod.getReadyStories(ctx);
}

function makeContext(root: string): ToolContext {
  return {
    projectRoot: root,
    sprintStatusPath: path.join(root, "sprint-status.yaml"),
    configPath: path.join(root, ".sprint-orchestrator", "config.yaml"),
  };
}

async function logStoryStart(root: string, storyId: string, agentId: string): Promise<void> {
  await appendRunLog(root, {
    event: "story_start",
    at: new Date().toISOString(),
    story_id: storyId,
    tool: "claimStory",
    agent_id: agentId,
  });
}

async function logStoryEnd(
  root: string,
  storyId: string,
  outcome: "complete" | "failed" | "needs_rework",
): Promise<void> {
  const tool =
    outcome === "complete"
      ? "markStoryComplete"
      : outcome === "failed"
        ? "markStoryFailed"
        : "markStoryNeedsRework";
  await appendRunLog(root, {
    event: "story_end",
    at: new Date().toISOString(),
    story_id: storyId,
    tool,
    outcome,
  });
}

interface DriveResult {
  shasBefore: string[];
  shasAfter: string[];
  commitMessages: string[];
  filesInLastTwoCommits: string[][];
  /** Branch HEAD was on at the moment the dev would commit (post-prepare). */
  branchAtCommitTime: string;
  /** Branch returned from prepareStoryBranch, or null when skipped. */
  preparedBranch: string | null;
}

function currentBranch(cwd: string): string {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
}

async function driveHappyPathStory(
  ctx: ToolContext,
  storyId: string,
  agent: string,
  prepareWorkingTree?: () => Promise<void>,
): Promise<DriveResult> {
  const before = git(ctx.projectRoot, ["rev-list", "HEAD"])
    .stdout.trim()
    .split("\n")
    .filter(Boolean);

  await logStoryStart(ctx.projectRoot, storyId, agent);
  const claim = await claimStory(ctx, storyId, agent);
  if (!claim.claimed) throw new Error(`could not claim ${storyId}: holder=${claim.holder ?? "?"}`);

  // Mirror the real process-backlog skill: between claimStory and the dev
  // subagent we prepare the per-story branch. This is a no-op when
  // pr_per_story is false; otherwise it checks out `<id>-<slug>` from
  // default_base.
  const prep = await prepareStoryBranch(ctx, storyId, agent);

  // Simulate the dev subagent making code changes.
  if (prepareWorkingTree) await prepareWorkingTree();

  const branchAtCommitTime = currentBranch(ctx.projectRoot);

  // Real flow: dev commits artefacts FIRST, then markStoryComplete persists state.
  await commitStoryArtefacts(ctx, storyId);
  await markStoryComplete(ctx, storyId, agent, `e2e: ${storyId} done`);
  await logStoryEnd(ctx.projectRoot, storyId, "complete");

  const after = git(ctx.projectRoot, ["rev-list", "HEAD"])
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  const newShas = after.filter((s) => !before.includes(s));
  const commitMessages = newShas.map((sha) =>
    git(ctx.projectRoot, ["log", "-1", "--format=%s", sha]).stdout.trim(),
  );
  const filesInLastTwoCommits = newShas.map((sha) =>
    git(ctx.projectRoot, ["show", "--name-only", "--format=", sha])
      .stdout.split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  return {
    shasBefore: before,
    shasAfter: after,
    commitMessages,
    filesInLastTwoCommits,
    branchAtCommitTime,
    preparedBranch: prep.branch,
  };
}

async function driveFailingStory(
  ctx: ToolContext,
  storyId: string,
  agent: string,
  reason: string,
): Promise<void> {
  await logStoryStart(ctx.projectRoot, storyId, agent);
  const claim = await claimStory(ctx, storyId, agent);
  if (!claim.claimed) throw new Error(`could not claim ${storyId}`);
  await markStoryFailed(ctx, storyId, reason);
  await logStoryEnd(ctx.projectRoot, storyId, "failed");
}

function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function readLog(root: string): Promise<Array<Record<string, unknown>>> {
  const p = path.join(root, ".sprint-orchestrator", "run.log");
  try {
    const txt = await fs.readFile(p, "utf8");
    return txt
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function buildAssertions(root: string): Promise<Assertion[]> {
  const ctx = makeContext(root);

  // Opt the primary run into per-story branches. The default is `false`
  // while the workflow is still incomplete; the per-story branch assertion
  // below depends on the flag being on, so we write an explicit config.
  await fs.mkdir(path.dirname(ctx.configPath), { recursive: true });
  await fs.writeFile(
    ctx.configPath,
    [
      "sprintStatusPath: sprint-status.yaml",
      "layout: custom",
      "autoDetected: false",
      "pr_per_story: true",
      "",
    ].join("\n"),
    "utf8",
  );

  // Drive the full flow once, capture artifacts, then run assertions.
  // A needs a real code change so the "two commits" assertion is meaningful;
  // its fixture AC just checks src/hello.txt exists, but commitStoryArtefacts
  // needs *something* in the working tree to commit as the "code" half.
  const happy = await driveHappyPathStory(ctx, "A", "agent-A", async () => {
    await fs.writeFile(path.join(root, "src", "hello.txt"), "hello (modified by A)\n", "utf8");
  });

  // Auto-promotion check happens BEFORE we touch B. After A is done,
  // getReadyStories should promote B from backlog to ready.
  //
  // We deliberately exercise the **published** entry (dist/) here, not the
  // TypeScript source. The orchestrator skill talks to the MCP server via
  // `node dist/index.js` (see plugins/sprint-orchestrator/.mcp.json), so a
  // src-only test is not a faithful repro of Jack's case. When dist is stale
  // relative to src (e.g. a fix that landed without rebuilding dist), this
  // assertion fails — exactly the silent regression Jack hit on Tinytodo
  // after bugfix-1 story #2 supposedly landed the promote helper.
  const ready = await getReadyStoriesViaDist(ctx);
  const readyIds = ready.map((s) => s.id);

  // Drive B (the auto-promoted story). Dev creates src/world.txt to satisfy AC,
  // AND seeds a NESTED workspace package's node_modules + dist directories.
  // This is the regression captured from PR #16 retest: top-level pathspec
  // exclusions (`:!node_modules`) only match repo-root, not deep paths like
  // apps/server/node_modules/. The fix is `:(exclude,glob)**/node_modules/**`.
  let bDriven: DriveResult | null = null;
  if (readyIds.includes("B")) {
    bDriven = await driveHappyPathStory(ctx, "B", "agent-B", async () => {
      await fs.writeFile(path.join(root, "src", "world.txt"), "world\n", "utf8");
      // Simulate a nested workspace package whose tooling produces dist + node_modules.
      const nested = path.join(root, "apps", "server");
      await fs.mkdir(path.join(nested, "node_modules", "fake-dep"), { recursive: true });
      await fs.writeFile(
        path.join(nested, "node_modules", "fake-dep", "index.js"),
        "// dep\n",
        "utf8",
      );
      await fs.mkdir(path.join(nested, "dist"), { recursive: true });
      await fs.writeFile(path.join(nested, "dist", "bundle.js"), "// built\n", "utf8");
      await fs.mkdir(path.join(nested, "src"), { recursive: true });
      await fs.writeFile(path.join(nested, "src", "app.ts"), "// real source\n", "utf8");
    });
  }

  // Drive C → failed.
  await driveFailingStory(ctx, "C", "agent-C", "designed-to-fail");

  const finalState = await readSprintStatus(ctx.sprintStatusPath);
  const storyA = finalState.stories.find((s) => s.id === "A");
  const storyB = finalState.stories.find((s) => s.id === "B");
  const storyC = finalState.stories.find((s) => s.id === "C");
  const log = await readLog(root);

  return [
    {
      name: "two commits per happy-path story (code + state)",
      run: () => {
        expect(
          happy.shasAfter.length - happy.shasBefore.length === 2,
          `expected 2 new commits for story A, got ${
            happy.shasAfter.length - happy.shasBefore.length
          } (messages: ${JSON.stringify(happy.commitMessages)})`,
        );
        // Exactly one of the two commits must touch sprint-status.yaml; the other
        // must not. This guards against the regression where both files land in
        // the same commit (or sprint-status never gets committed).
        const touches = happy.filesInLastTwoCommits.map((files) =>
          files.includes("sprint-status.yaml"),
        );
        const yamlCommits = touches.filter(Boolean).length;
        expect(
          yamlCommits === 1,
          `expected exactly 1 of the 2 new commits to touch sprint-status.yaml, got ${yamlCommits}`,
        );
      },
    },
    {
      name: "happy-path story has completed_at and status=done",
      run: () => {
        expect(!!storyA, "story A missing from final state");
        expect(storyA!.status === "done", `story A status=${storyA!.status}`);
        expect(
          typeof storyA!.orchestrator.completed_at === "string",
          "story A completed_at missing",
        );
      },
    },
    {
      name: "auto-promotion: backlog story with done dep returned by getReadyStories",
      run: () => {
        expect(
          readyIds.includes("B"),
          `expected B in ready set after A done, got [${readyIds.join(", ")}]`,
        );
      },
    },
    {
      name: "failed status: markStoryFailed writes status=failed (not blocked)",
      run: () => {
        expect(!!storyC, "story C missing from final state");
        expect(storyC!.status === "failed", `story C status=${storyC!.status} (expected "failed")`);
      },
    },
    {
      name: "no junk files in any orchestrator-produced commit",
      run: () => {
        const allFiles = [
          ...happy.filesInLastTwoCommits.flat(),
          ...(bDriven ? bDriven.filesInLastTwoCommits.flat() : []),
        ];
        const junk = allFiles.filter(
          (f) =>
            f === ".DS_Store" ||
            f.endsWith("/.DS_Store") ||
            f.startsWith(".sprint-orchestrator/") ||
            f === ".sprint-orchestrator" ||
            f.startsWith(".claude/") ||
            f.includes("/node_modules/") ||
            f.includes("/dist/") ||
            f.endsWith("/dist") ||
            f === "dist",
        );
        expect(
          junk.length === 0,
          `junk files committed: ${JSON.stringify(junk)} (all files: ${JSON.stringify(allFiles)})`,
        );
      },
    },
    {
      name: "run.log contains story_start and story_end with matching outcomes",
      run: () => {
        const starts = log.filter((e) => e.event === "story_start");
        const ends = log.filter((e) => e.event === "story_end");
        expect(starts.length >= 2, `expected >=2 story_start entries, got ${starts.length}`);
        expect(ends.length >= 2, `expected >=2 story_end entries, got ${ends.length}`);
        const cEnd = ends.find((e) => e.story_id === "C");
        expect(!!cEnd, "no story_end entry for story C");
        expect(
          cEnd!.outcome === "failed",
          `story C end outcome=${String(cEnd!.outcome)} (expected "failed")`,
        );
        const aEnd = ends.find((e) => e.story_id === "A");
        expect(!!aEnd, "no story_end entry for story A");
        expect(
          aEnd!.outcome === "complete",
          `story A end outcome=${String(aEnd!.outcome)} (expected "complete")`,
        );
      },
    },
    {
      name: "auto-promoted story B finishes with status=done",
      run: () => {
        expect(!!storyB, "story B missing from final state");
        expect(
          storyB!.status === "done",
          `story B status=${storyB!.status} (expected "done"; auto-promotion likely failed)`,
        );
      },
    },
    {
      name: "branch-per-story: dependent story's branch is rooted at the dependency's branch tip",
      run: () => {
        // Story B depends on A. With pr_per_story=true and A already done on
        // its own per-story branch, prepareStoryBranch must root B from A's
        // branch tip (not from main), so the dev subagent on B can see A's
        // commits via plain `git log`.
        expect(!!bDriven, "story B was not driven; auto-promotion path likely broke");
        const aBranch = "a-happy-path-story";
        const bBranch = "b-backlog-story-that-should-auto-promote-w";
        expect(
          bDriven!.preparedBranch === bBranch,
          `expected preparedBranch=${bBranch}, got ${String(bDriven!.preparedBranch)}`,
        );
        // A's commits must be reachable from B's branch (i.e. B was rooted
        // from A's tip, not from main).
        const aShas = git(ctx.projectRoot, ["rev-list", aBranch])
          .stdout.trim()
          .split("\n")
          .filter(Boolean);
        const bShas = git(ctx.projectRoot, ["rev-list", bBranch])
          .stdout.trim()
          .split("\n")
          .filter(Boolean);
        for (const sha of aShas) {
          expect(
            bShas.includes(sha),
            `A's commit ${sha} not reachable from ${bBranch} — B is not rooted at A's tip`,
          );
        }
        // B's first new commit's parent must be reachable from A's tip.
        const bNewShas = bDriven!.shasAfter.filter((s) => !bDriven!.shasBefore.includes(s));
        expect(bNewShas.length > 0, "no new commits found for story B");
        // The oldest of B's new commits is at the end of bNewShas (rev-list
        // is newest-first). Walk to the first commit on B that is NOT an
        // A-reachable commit; its parent must be A's tip.
        const oldestBNew = bNewShas[bNewShas.length - 1]!;
        const parentSha = git(ctx.projectRoot, ["rev-parse", `${oldestBNew}^`]).stdout.trim();
        expect(
          aShas.includes(parentSha),
          `B's first commit ${oldestBNew} has parent ${parentSha} which is not reachable from ${aBranch}`,
        );
        // State should record the chosen base.
        expect(
          (storyB!.orchestrator as Record<string, unknown>).base_branch === aBranch,
          `story B orchestrator.base_branch=${String(
            (storyB!.orchestrator as Record<string, unknown>).base_branch,
          )} (expected ${aBranch})`,
        );
        expect(
          (storyB!.orchestrator as Record<string, unknown>).base_branch_fallback_reason ===
            undefined,
          `unexpected base_branch_fallback_reason=${String(
            (storyB!.orchestrator as Record<string, unknown>).base_branch_fallback_reason,
          )}`,
        );
      },
    },
    {
      name: "branch-per-story: story A's commits land on its own branch when flag is on",
      run: () => {
        // The primary run writes pr_per_story: true into config above, so
        // prepareStoryBranch should have checked out a per-story branch
        // named `<id-slug>-<title-slug>`.
        const expectedBranch = "a-happy-path-story";
        expect(
          happy.preparedBranch === expectedBranch,
          `expected preparedBranch=${expectedBranch}, got ${String(happy.preparedBranch)}`,
        );
        expect(
          happy.branchAtCommitTime === expectedBranch,
          `expected HEAD on ${expectedBranch} at commit time, got ${happy.branchAtCommitTime}`,
        );
        // Both A's commits must be reachable from the per-story branch tip
        // and NOT from main (because main was never advanced).
        const branchCommits = git(ctx.projectRoot, ["rev-list", expectedBranch])
          .stdout.trim()
          .split("\n")
          .filter(Boolean);
        const newShas = happy.shasAfter.filter((s) => !happy.shasBefore.includes(s));
        for (const sha of newShas) {
          expect(branchCommits.includes(sha), `commit ${sha} not reachable from ${expectedBranch}`);
        }
        const mainCommits = git(ctx.projectRoot, ["rev-list", "main"])
          .stdout.trim()
          .split("\n")
          .filter(Boolean);
        for (const sha of newShas) {
          expect(
            !mainCommits.includes(sha),
            `commit ${sha} unexpectedly reachable from main (story-branch should be local only)`,
          );
        }
        // And the story state should record the branch so downstream tooling
        // (push / PR open in slice 1.2) can read it back.
        expect(
          (storyA!.orchestrator as Record<string, unknown>).branch === expectedBranch,
          `story A orchestrator.branch=${String((storyA!.orchestrator as Record<string, unknown>).branch)} (expected ${expectedBranch})`,
        );
      },
    },
  ];
}

/**
 * Mini-run: spin up a second temp repo with `pr_per_story: false` set
 * explicitly in `.sprint-orchestrator/config.yaml`, drive one happy story,
 * and verify the dev's commits land on the initial branch (no per-story
 * branch is created). Guards the opt-out path against future regressions.
 */
async function runOptOutMiniRun(): Promise<AssertionOutcome[]> {
  const root = await setupTempRepo();
  const ctx = makeContext(root);
  // Write a config with pr_per_story explicitly disabled. The fixture itself
  // does not ship a .sprint-orchestrator/ dir, and getOrInitConfig will not
  // detect a BMAD layout here (no docs/prd.md) — so without an explicit
  // config the tool would no-op via the "no-config" branch. Writing the
  // config makes the assertion specifically about the opt-out flag.
  const configDir = path.join(root, ".sprint-orchestrator");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.yaml"),
    [
      "sprintStatusPath: sprint-status.yaml",
      "autoDetected: false",
      'layout: "custom"',
      "pr_per_story: false",
      'default_base: "main"',
      "",
    ].join("\n"),
    "utf8",
  );
  const initialBranch = currentBranch(root);

  const outcomes: AssertionOutcome[] = [];
  try {
    const happy = await driveHappyPathStory(ctx, "A", "agent-A-optout", async () => {
      await fs.writeFile(path.join(root, "src", "hello.txt"), "hello (opt-out)\n", "utf8");
    });
    const finalBranch = currentBranch(root);
    const finalState = await readSprintStatus(ctx.sprintStatusPath);
    const storyA = finalState.stories.find((s) => s.id === "A");

    const checks: Assertion[] = [
      {
        name: "branch-per-story opt-out: prepareStoryBranch returns null when pr_per_story=false",
        run: () => {
          expect(
            happy.preparedBranch === null,
            `expected preparedBranch=null, got ${String(happy.preparedBranch)}`,
          );
        },
      },
      {
        name: "branch-per-story opt-out: HEAD stays on the initial branch (no feature branch created)",
        run: () => {
          expect(
            happy.branchAtCommitTime === initialBranch,
            `expected commit-time branch=${initialBranch}, got ${happy.branchAtCommitTime}`,
          );
          expect(
            finalBranch === initialBranch,
            `expected final branch=${initialBranch}, got ${finalBranch}`,
          );
        },
      },
      {
        name: "branch-per-story opt-out: commits land on the initial branch and story.orchestrator.branch is unset",
        run: () => {
          const branchCommits = git(root, ["rev-list", initialBranch])
            .stdout.trim()
            .split("\n")
            .filter(Boolean);
          const newShas = happy.shasAfter.filter((s) => !happy.shasBefore.includes(s));
          expect(newShas.length === 2, `expected 2 new commits, got ${newShas.length}`);
          for (const sha of newShas) {
            expect(
              branchCommits.includes(sha),
              `commit ${sha} not reachable from ${initialBranch}`,
            );
          }
          expect(
            (storyA!.orchestrator as Record<string, unknown>).branch === undefined,
            `expected no orchestrator.branch when opted out, got ${String(
              (storyA!.orchestrator as Record<string, unknown>).branch,
            )}`,
          );
        },
      },
    ];

    for (const a of checks) {
      try {
        await a.run();
        outcomes.push({ name: a.name, passed: true });
        console.log(`  PASS  ${a.name}`);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        outcomes.push({ name: a.name, passed: false, error: msg });
        console.log(`  FAIL  ${a.name}\n        ${msg}`);
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  return outcomes;
}

/**
 * Mini-run: spin up a temp repo whose `main` branch's sprint-status.yaml is
 * missing the current `schema_version`, advance the invocation branch with a
 * schema-shaped change, and drive one story with `pr_per_story=true`. Asserts
 * that `prepareStoryBranch` refuses with `reason="default_base-stale"` and
 * does NOT move HEAD off the invocation branch. Guards against the
 * 200+-line-chore-commit regression captured on slice 1.1.
 */
async function runStaleBaseMiniRun(): Promise<AssertionOutcome[]> {
  const root = await setupTempRepo();
  const ctx = makeContext(root);

  // The initial commit (setupTempRepo) seeded main with the fixture, which
  // ships `schema_version: 1`. Rewrite main's sprint-status to drop the
  // schema_version field so it looks "stale" to a server expecting v1, then
  // commit that on main directly.
  const sprintPath = path.join(root, "sprint-status.yaml");
  const original = await fs.readFile(sprintPath, "utf8");
  const stale = original.replace(/^schema_version:.*\n/m, "");
  await fs.writeFile(sprintPath, stale, "utf8");
  const stageStale = git(root, ["add", "sprint-status.yaml"]);
  if (stageStale.status !== 0) throw new Error(`stage stale failed: ${stageStale.stderr}`);
  const commitStale = git(root, [
    "commit",
    "-q",
    "-m",
    "main: drop schema_version (simulate stale)",
  ]);
  if (commitStale.status !== 0) throw new Error(`commit stale failed: ${commitStale.stderr}`);

  // Now create a feature branch and re-add schema_version on it — this is
  // the "invocation branch advances with a schema-shaped change" the story
  // calls out. The fixture's other branches/files are untouched.
  const invocation = "feat/schema-bump";
  const checkoutFeat = git(root, ["checkout", "-q", "-b", invocation]);
  if (checkoutFeat.status !== 0) throw new Error(`checkout feat failed: ${checkoutFeat.stderr}`);
  await fs.writeFile(sprintPath, original, "utf8");
  const stageFeat = git(root, ["add", "sprint-status.yaml"]);
  if (stageFeat.status !== 0) throw new Error(`stage feat failed: ${stageFeat.stderr}`);
  const commitFeat = git(root, ["commit", "-q", "-m", "feat: bump schema_version to 1"]);
  if (commitFeat.status !== 0) throw new Error(`commit feat failed: ${commitFeat.stderr}`);

  // Configure pr_per_story=true with default_base=main so the new check
  // fires.
  const configDir = path.join(root, ".sprint-orchestrator");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.yaml"),
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

  const branchBefore = currentBranch(root);
  const headBefore = git(root, ["rev-parse", "HEAD"]).stdout.trim();

  // Drive: claim then call prepareStoryBranch. We deliberately do NOT call
  // the full happy-path driver — once prepareStoryBranch refuses, the skill
  // is meant to stop, so faking a commit on top would defeat the assertion.
  await logStoryStart(root, "A", "agent-stale");
  const claim = await claimStory(ctx, "A", "agent-stale");

  const outcomes: AssertionOutcome[] = [];
  try {
    if (!claim.claimed) throw new Error(`could not claim A: holder=${claim.holder ?? "?"}`);
    const prep = await prepareStoryBranch(ctx, "A", "agent-stale");
    const branchAfter = currentBranch(root);
    const headAfter = git(root, ["rev-parse", "HEAD"]).stdout.trim();

    const checks: Assertion[] = [
      {
        name: "refuses when default_base lacks orchestrator schema: prep.skipped=true with reason=default_base-stale",
        run: () => {
          expect(prep.skipped === true, `expected prep.skipped=true, got ${String(prep.skipped)}`);
          expect(
            prep.reason === "default_base-stale",
            `expected reason=default_base-stale, got ${String(prep.reason)}`,
          );
          expect(prep.branch === null, `expected branch=null, got ${String(prep.branch)}`);
          expect(
            typeof prep.message === "string" && prep.message.includes("default_base"),
            `expected message to mention default_base, got ${String(prep.message)}`,
          );
        },
      },
      {
        name: "refuses when default_base lacks orchestrator schema: HEAD does not move off the invocation branch",
        run: () => {
          expect(
            branchAfter === branchBefore,
            `expected HEAD on ${branchBefore}, got ${branchAfter}`,
          );
          expect(
            headAfter === headBefore,
            `expected HEAD sha unchanged (${headBefore}), got ${headAfter}`,
          );
        },
      },
    ];

    for (const a of checks) {
      try {
        await a.run();
        outcomes.push({ name: a.name, passed: true });
        console.log(`  PASS  ${a.name}`);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        outcomes.push({ name: a.name, passed: false, error: msg });
        console.log(`  FAIL  ${a.name}\n        ${msg}`);
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  return outcomes;
}

/**
 * Mini-run for story 3: simulate a "fresh session" on a repo whose
 * sprint-status.yaml carries leftover dirt from a prior, crashed session —
 * i.e. NO orchestrator MCP tool has been called in this session. Then fire
 * the Stop hook (which is what Claude Code invokes at session end) and
 * assert that no new commits land.
 *
 * BEFORE the story-3 fix, the stop hook unconditionally ran
 * `commitMetadataOnly`, producing a `chore(sprint): persist story metadata`
 * commit attributable to a session that did nothing. That is the
 * cross-session leak users reported (a stray `chore(sprint): persist 1.1
 * failure`-style commit appearing on the next session for a branch).
 *
 * AFTER the fix, the tidy step only runs when handleClaimed actually
 * transitioned a story (completed or failed) in this session; a noop session
 * leaves the dirt alone.
 */
async function runCrossSessionStrayCommitMiniRun(): Promise<AssertionOutcome[]> {
  const root = await setupTempRepo();
  const ctx = makeContext(root);
  const sprintPath = ctx.sprintStatusPath;

  // Capture HEAD before we do anything.
  const headBefore = git(root, ["rev-parse", "HEAD"]).stdout.trim();
  const commitsBefore = git(root, ["rev-list", "HEAD"]).stdout.trim().split("\n").filter(Boolean);

  // Simulate residue from a prior session: append a harmless-but-real edit to
  // sprint-status.yaml without going through any orchestrator tool. Use an
  // appended YAML comment so the file still parses (handleStop reads it).
  const original = await fs.readFile(sprintPath, "utf8");
  await fs.writeFile(sprintPath, `${original}# stray edit from a prior session\n`, "utf8");

  // CRUCIAL: do NOT call any MCP orchestrator tool in this "session". Just
  // fire the Stop hook directly, as the Claude Code harness would when the
  // user closes a session that never touched the orchestrator.
  let stopResult: Awaited<ReturnType<typeof handleStop>> | null = null;
  const outcomes: AssertionOutcome[] = [];
  try {
    stopResult = await handleStop({ cwd: root });

    const headAfter = git(root, ["rev-parse", "HEAD"]).stdout.trim();
    const commitsAfter = git(root, ["rev-list", "HEAD"]).stdout.trim().split("\n").filter(Boolean);
    const newCommits = commitsAfter.filter((s) => !commitsBefore.includes(s));
    const newMessages = newCommits.map((sha) =>
      git(root, ["log", "-1", "--format=%s", sha]).stdout.trim(),
    );

    const checks: Assertion[] = [
      {
        name: "no orchestrator commits appear without a tool call in the current session",
        run: () => {
          // No tool called this session => no commits should be created by
          // the stop hook, even if sprint-status.yaml was dirty on entry.
          expect(
            newCommits.length === 0,
            `expected 0 new commits when no orchestrator tool was called this session, got ${
              newCommits.length
            } (messages: ${JSON.stringify(newMessages)})`,
          );
          expect(
            headAfter === headBefore,
            `expected HEAD unchanged (${headBefore}), got ${headAfter}`,
          );
          expect(
            stopResult!.action === "noop",
            `expected action=noop when nothing in_progress, got ${String(stopResult!.action)}`,
          );
          expect(
            stopResult!.tidyCommitSha == null,
            `expected tidyCommitSha=null on a no-activity session, got ${String(
              stopResult!.tidyCommitSha,
            )}`,
          );
        },
      },
    ];

    for (const a of checks) {
      try {
        await a.run();
        outcomes.push({ name: a.name, passed: true });
        console.log(`  PASS  ${a.name}`);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        outcomes.push({ name: a.name, passed: false, error: msg });
        console.log(`  FAIL  ${a.name}\n        ${msg}`);
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  return outcomes;
}

/**
 * Mini-run for the reviewer-escalation contract: when an AC fails on the
 * first reviewer pass, the reviewer MUST take the rework path (not failure)
 * whenever the dev produced new code on this swing. This guards against the
 * regression captured in the pr-per-story-1.1-triage run, where two stories
 * hard-failed at rework_count: 0 despite having a valid feat commit on disk.
 *
 * The e2e cannot drive the reviewer LLM directly, so this mini-run drives the
 * MCP-side state machine the reviewer commits to: it simulates a dev that
 * produced a feat commit which does NOT satisfy the AC, then calls
 * markStoryNeedsRework (the call the reviewer MUST make in this scenario) and
 * asserts the post-state matches the contract — no failed status, rework_count
 * advanced to 1, claim still in place.
 */
async function runReviewerReworkOnFirstACMissMiniRun(): Promise<AssertionOutcome[]> {
  const root = await setupTempRepo();
  const ctx = makeContext(root);

  // Use pr_per_story: false so we don't need to manage a per-story branch for
  // this assertion — the rework escalation logic is branch-agnostic.
  const configDir = path.join(root, ".sprint-orchestrator");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.yaml"),
    [
      "sprintStatusPath: sprint-status.yaml",
      "autoDetected: false",
      'layout: "custom"',
      "pr_per_story: false",
      'default_base: "main"',
      "",
    ].join("\n"),
    "utf8",
  );

  const agent = "agent-rework-on-first-miss";
  const outcomes: AssertionOutcome[] = [];

  try {
    // Story C in the fixture has a never-passing AC
    // (file_exists this/path/does/not/exist.txt). Perfect for this scenario:
    // the dev "produces code" but the AC still fails.
    const claim = await claimStory(ctx, "C", agent);
    if (!claim.claimed) throw new Error(`could not claim C: holder=${claim.holder ?? "?"}`);

    // Simulate the dev subagent producing a real feat commit that touches
    // source files (but does NOT satisfy the AC). This is exactly the
    // scenario from the triage run: dev produced plausible code, AC still
    // fails on the first pass.
    await fs.writeFile(path.join(root, "src", "attempt.txt"), "dev's attempt at C\n", "utf8");
    const addAttempt = git(root, ["add", "src/attempt.txt"]);
    if (addAttempt.status !== 0) throw new Error(`stage attempt failed: ${addAttempt.stderr}`);
    const commitAttempt = git(root, [
      "commit",
      "-q",
      "-m",
      "feat(C): dev attempt that does not satisfy AC",
    ]);
    if (commitAttempt.status !== 0) {
      throw new Error(`commit attempt failed: ${commitAttempt.stderr}`);
    }

    // Reviewer pass: validateAcceptanceCriteria should fail.
    const validation = await validateAcceptanceCriteria(ctx, "C");

    // Reviewer's decision per the new contract: AC failed AND there is a
    // feat commit since claimed_at => call recordStoryRework, NOT
    // recordStoryFailure.
    const rework = await markStoryNeedsRework(
      ctx,
      "C",
      agent,
      `AC failed: ${JSON.stringify(validation)}`,
    );

    const finalState = await readSprintStatus(ctx.sprintStatusPath);
    const storyC = finalState.stories.find((s) => s.id === "C");

    const checks: Assertion[] = [
      {
        name: "reviewer escalates to rework, not failure, on first AC miss after dev produced code",
        run: () => {
          expect(!!storyC, "story C missing from final state");
          // Core contract: rework path taken, not failure path.
          expect(
            storyC!.status !== "failed",
            `story C status=${storyC!.status} — reviewer must NOT flip to failed on first AC miss when dev produced code`,
          );
          // No failed_at means recordStoryFailure was not called.
          expect(
            (storyC!.orchestrator as Record<string, unknown>).failed_at === undefined,
            `story C orchestrator.failed_at=${String(
              (storyC!.orchestrator as Record<string, unknown>).failed_at,
            )} — must be unset on the rework path`,
          );
          // rework_count must have advanced to 1.
          expect(
            storyC!.orchestrator.rework_count === 1,
            `story C rework_count=${String(
              storyC!.orchestrator.rework_count,
            )} (expected 1 after one rework escalation)`,
          );
          // Status must remain in_progress so the same dev can take another swing.
          expect(
            storyC!.status === "in_progress",
            `story C status=${storyC!.status} (expected "in_progress" so the dev can retry)`,
          );
          // markStoryNeedsRework returned reworkCount=1, capReached=false (cap is 2).
          expect(
            rework.reworkCount === 1,
            `recordStoryRework returned reworkCount=${rework.reworkCount} (expected 1)`,
          );
          expect(
            rework.capReached === false,
            `recordStoryRework returned capReached=${rework.capReached} (expected false on first rework)`,
          );
          // The reviewer's reason must be persisted as last_review_feedback so
          // the dev on the next swing can read it.
          expect(
            typeof (storyC!.orchestrator as Record<string, unknown>).last_review_feedback ===
              "string",
            "story C last_review_feedback missing — dev cannot see the failure on retry",
          );
          // Claim stays in place so the same dev picks the story up again.
          expect(
            storyC!.orchestrator.claimed_by === agent,
            `story C claimed_by=${String(
              storyC!.orchestrator.claimed_by,
            )} (expected the original agent; rework must not release the claim)`,
          );
        },
      },
    ];

    for (const a of checks) {
      try {
        await a.run();
        outcomes.push({ name: a.name, passed: true });
        console.log(`  PASS  ${a.name}`);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        outcomes.push({ name: a.name, passed: false, error: msg });
        console.log(`  FAIL  ${a.name}\n        ${msg}`);
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  return outcomes;
}

/**
 * Mini-run for story 2: when the reviewer attempts a state-mutating MCP call
 * on a story whose status no longer allows that transition (e.g. another
 * session moved it to `failed`), the MCP server rejects the call. The
 * reviewer's contract is to surface a `blocked: <id>` status line and STOP
 * the run — NOT to silently treat the rejection as a normal `done`/`failed`
 * outcome.
 *
 * The e2e cannot drive the reviewer LLM directly, so this mini-run drives the
 * MCP-side state machine the reviewer is supposed to commit to:
 *   1. Pre-seed story C in `failed` state (simulating the cross-session drift).
 *   2. Re-claim it for a "new" reviewer agent (without going through the
 *      normal claimStory state-machine path — we hand-edit sprint-status so
 *      the story is in_progress-looking only insofar as the reviewer would
 *      try to call recordStorySuccess on it).
 *   3. Attempt `markStoryComplete` (the dist-mode name for the tool the
 *      reviewer calls). Expect it to throw `InvalidStateTransitionError`.
 *   4. Mimic the reviewer's contract: write a `blocked` event into run.log
 *      and synthesize the `blocked: <id> ...` stdout line.
 *   5. Assert: story.status stays `failed`, the synthesized stdout line
 *      matches the contract, and run.log carries a `blocked` event with the
 *      offending tool name and error.
 */
async function runReviewerBlockedOnRejectedTransitionMiniRun(): Promise<AssertionOutcome[]> {
  const root = await setupTempRepo();
  const ctx = makeContext(root);

  const configDir = path.join(root, ".sprint-orchestrator");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.yaml"),
    [
      "sprintStatusPath: sprint-status.yaml",
      "autoDetected: false",
      'layout: "custom"',
      "pr_per_story: false",
      'default_base: "main"',
      "",
    ].join("\n"),
    "utf8",
  );

  const agent = "agent-blocked-on-rejected-transition";
  const outcomes: AssertionOutcome[] = [];

  try {
    // Step 1: pre-seed C in `failed` state via the normal path (this is the
    // "prior session" leaving the bookkeeping in a state the new reviewer
    // cannot transition out of).
    const claim1 = await claimStory(ctx, "C", "agent-prior-session");
    if (!claim1.claimed) throw new Error(`could not claim C: holder=${claim1.holder ?? "?"}`);
    await markStoryFailed(ctx, "C", "prior session gave up");

    // Sanity: story is now `failed`.
    const midState = await readSprintStatus(ctx.sprintStatusPath);
    const midC = midState.stories.find((s) => s.id === "C");
    if (!midC || midC.status !== "failed") {
      throw new Error(`expected C status=failed before reviewer pass, got ${String(midC?.status)}`);
    }

    // Step 2: the reviewer LLM is invoked for C with `agent`. The reviewer
    // believes AC has passed (this is what it would do in a re-claimed
    // scenario where it doesn't re-check the persisted status) and calls
    // recordStorySuccess. We simulate that call directly.
    //
    // Step 3: expect rejection.
    let captured: Error | null = null;
    try {
      await markStoryComplete(ctx, "C", agent, "reviewer believes C is done");
    } catch (err) {
      captured = err as Error;
    }

    // Step 4: mimic the reviewer's blocked-line contract + run.log event.
    const toolName = "recordStorySuccess";
    const errorText = captured ? captured.message : "<no error thrown>";
    const reviewerStdoutLine = `blocked: C — state-machine rejected ${toolName}: ${errorText}`;
    if (captured) {
      await appendRunLog(root, {
        event: "blocked",
        at: new Date().toISOString(),
        story_id: "C",
        tool: toolName,
        error: errorText,
        agent_id: agent,
      });
    }

    const finalState = await readSprintStatus(ctx.sprintStatusPath);
    const storyC = finalState.stories.find((s) => s.id === "C");
    const log = await readLog(root);

    const checks: Assertion[] = [
      {
        name: "reviewer returns blocked status when state machine rejects recordStorySuccess",
        run: () => {
          // The MCP server must have rejected the transition.
          expect(
            captured !== null,
            "expected markStoryComplete to throw on a failed story; got no error",
          );
          // Error message must carry the from/to context so the blocked: line is informative.
          expect(
            captured!.message.includes("failed") && captured!.message.includes("done"),
            `expected error to mention failed→done transition, got: ${captured!.message}`,
          );
          // Reviewer's synthesized stdout line matches the contract.
          expect(
            reviewerStdoutLine.startsWith("blocked: C"),
            `expected stdout line to start with "blocked: C", got: ${reviewerStdoutLine}`,
          );
          expect(
            reviewerStdoutLine.includes(`state-machine rejected ${toolName}`),
            `expected stdout line to name the rejected tool, got: ${reviewerStdoutLine}`,
          );
          expect(
            reviewerStdoutLine.includes(captured!.message),
            `expected stdout line to carry the verbatim error, got: ${reviewerStdoutLine}`,
          );
          // Story status must remain `failed` — no silent transition happened.
          expect(!!storyC, "story C missing from final state");
          expect(
            storyC!.status === "failed",
            `story C status=${storyC!.status} (expected "failed"; rejected transition must not mutate state)`,
          );
          // run.log must carry a `blocked` event so post-mortem analysis can find it.
          const blocked = log.filter((e) => e.event === "blocked");
          expect(
            blocked.length >= 1,
            `expected >=1 blocked event in run.log, got ${blocked.length}`,
          );
          const evt = blocked.find((e) => e.story_id === "C");
          expect(!!evt, "no blocked event for story C in run.log");
          expect(
            evt!.tool === toolName,
            `blocked event tool=${String(evt!.tool)} (expected ${toolName})`,
          );
          expect(
            typeof evt!.error === "string" &&
              (evt!.error as string).includes("failed") &&
              (evt!.error as string).includes("done"),
            `blocked event error missing transition context, got: ${String(evt!.error)}`,
          );
        },
      },
    ];

    for (const a of checks) {
      try {
        await a.run();
        outcomes.push({ name: a.name, passed: true });
        console.log(`  PASS  ${a.name}`);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        outcomes.push({ name: a.name, passed: false, error: msg });
        console.log(`  FAIL  ${a.name}\n        ${msg}`);
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  return outcomes;
}

/**
 * Mini-run for story 3: drive a story all the way to `failed` with rework
 * activity, then call `recordStoryReopen` and assert the story is back in the
 * ready queue with rework_count preserved, failure fields cleared, an entry
 * appended to reopen_history, and a `chore(sprint): reopen` commit on HEAD.
 */
async function runRecordStoryReopenMiniRun(): Promise<AssertionOutcome[]> {
  const root = await setupTempRepo();
  const ctx = makeContext(root);

  const configDir = path.join(root, ".sprint-orchestrator");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.yaml"),
    [
      "sprintStatusPath: sprint-status.yaml",
      "autoDetected: false",
      'layout: "custom"',
      "pr_per_story: false",
      'default_base: "main"',
      "",
    ].join("\n"),
    "utf8",
  );

  const agent = "agent-reopen-driver";
  const outcomes: AssertionOutcome[] = [];

  try {
    // Story C has a never-passing AC. Drive it through one rework attempt to
    // ensure rework_count > 0, then hit the cap and flip to failed via the
    // reviewer's normal path (markStoryNeedsRework + markStoryFailed).
    const claim = await claimStory(ctx, "C", agent);
    if (!claim.claimed) throw new Error(`could not claim C: holder=${claim.holder ?? "?"}`);

    // One rework attempt (cap default is 2). After this, rework_count=1.
    await markStoryNeedsRework(ctx, "C", agent, "first reviewer rejection");

    // Reviewer gives up. Flip to failed (cap reached, no-code failure, etc).
    await markStoryFailed(ctx, "C", "rework cap reached after no progress");

    const failedState = await readSprintStatus(ctx.sprintStatusPath);
    const failedC = failedState.stories.find((s) => s.id === "C");
    if (!failedC || failedC.status !== "failed") {
      throw new Error(`expected C status=failed before reopen, got ${String(failedC?.status)}`);
    }
    const failedReworkCount = failedC.orchestrator.rework_count ?? 0;

    const headBefore = git(root, ["rev-parse", "HEAD"]).stdout.trim();

    // The action under test.
    const reopenReason = "human override: deferred work resolved";
    const reopenResult = await recordStoryReopen(ctx, "C", reopenReason);

    const finalState = await readSprintStatus(ctx.sprintStatusPath);
    const storyC = finalState.stories.find((s) => s.id === "C");

    const headAfter = git(root, ["rev-parse", "HEAD"]).stdout.trim();
    const lastMsg = git(root, ["log", "-1", "--format=%s"]).stdout.trim();
    const ready = await getReadyStories(ctx);
    const readyIds = ready.map((s) => s.id);

    const checks: Assertion[] = [
      {
        name: "recordStoryReopen transitions a failed story back to ready and clears failure fields",
        run: () => {
          expect(!!storyC, "story C missing from final state");
          expect(
            storyC!.status === "ready",
            `story C status=${storyC!.status} (expected "ready" after reopen)`,
          );
          const orch = storyC!.orchestrator as Record<string, unknown>;
          expect(
            orch.failed_at === undefined,
            `story C failed_at=${String(orch.failed_at)} (expected cleared)`,
          );
          expect(
            orch.last_failure_reason === undefined,
            `story C last_failure_reason=${String(orch.last_failure_reason)} (expected cleared)`,
          );
          expect(
            orch.claimed_by === undefined,
            `story C claimed_by=${String(orch.claimed_by)} (expected cleared)`,
          );
          expect(
            orch.claimed_at === undefined,
            `story C claimed_at=${String(orch.claimed_at)} (expected cleared)`,
          );
          // rework_count preserved.
          expect(
            (storyC!.orchestrator.rework_count ?? 0) === failedReworkCount,
            `story C rework_count=${String(
              storyC!.orchestrator.rework_count,
            )} (expected preserved at ${failedReworkCount})`,
          );
          expect(
            failedReworkCount >= 1,
            `precondition: failed story should have rework_count >= 1 to prove preservation, got ${failedReworkCount}`,
          );
          // reopen_history carries the audit entry.
          const history = orch.reopen_history as Array<Record<string, unknown>> | undefined;
          expect(Array.isArray(history), "reopen_history missing or not an array");
          expect(history!.length === 1, `expected reopen_history length 1, got ${history!.length}`);
          expect(
            history![0]!.reason === reopenReason,
            `reopen_history[0].reason=${String(history![0]!.reason)} (expected ${reopenReason})`,
          );
          expect(
            history![0]!.prior_status === "failed",
            `reopen_history[0].prior_status=${String(history![0]!.prior_status)} (expected "failed")`,
          );
          expect(
            history![0]!.prior_failure_reason === "rework cap reached after no progress",
            `reopen_history[0].prior_failure_reason=${String(history![0]!.prior_failure_reason)}`,
          );
          // Tool return value.
          expect(
            reopenResult.status === "ready",
            `reopenResult.status=${reopenResult.status} (expected "ready")`,
          );
          expect(
            reopenResult.reworkCount === failedReworkCount,
            `reopenResult.reworkCount=${reopenResult.reworkCount} (expected ${failedReworkCount})`,
          );
          // getReadyStories now includes C.
          expect(
            readyIds.includes("C"),
            `expected C in ready set after reopen, got [${readyIds.join(", ")}]`,
          );
          // Chore commit on HEAD.
          expect(
            headAfter !== headBefore,
            `expected a new commit after reopen, HEAD unchanged at ${headAfter}`,
          );
          expect(
            /^chore\(sprint\): reopen C — /.test(lastMsg),
            `expected HEAD message to match "chore(sprint): reopen C — ...", got: ${lastMsg}`,
          );
          expect(
            lastMsg.includes(reopenReason),
            `expected HEAD message to carry the reason, got: ${lastMsg}`,
          );
        },
      },
    ];

    for (const a of checks) {
      try {
        await a.run();
        outcomes.push({ name: a.name, passed: true });
        console.log(`  PASS  ${a.name}`);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        outcomes.push({ name: a.name, passed: false, error: msg });
        console.log(`  FAIL  ${a.name}\n        ${msg}`);
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  return outcomes;
}

/**
 * Mini-run for story 4: lintSprint must flag shell `cmd` fields that would
 * break YAML.parse if dumped unquoted (e.g. unquoted apostrophe + colon
 * inside a `--grep "x: y"` arg). The fixture sprint here writes such a cmd
 * literally — the kind of content a sprint-planning LLM emits when it forgets
 * to quote the value.
 */
async function runLintSprintYamlSafetyMiniRun(): Promise<AssertionOutcome[]> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sprint-orch-lint-yaml-"));
  const outcomes: AssertionOutcome[] = [];
  try {
    // Hand-author the sprint-status.yaml so the unquoted `"x: y"` reaches
    // disk verbatim — that's the on-the-wire shape the regression-producing
    // story shipped, and what lintSprint must reject.
    const sprintPath = path.join(root, "sprint-status.yaml");
    const sprintYaml = [
      "schema_version: 1",
      'sprint_id: "lint-yaml-safety-fixture"',
      "stories:",
      '  - id: "Y1"',
      '    title: "shell cmd has unquoted colon inside double-quoted grep arg"',
      "    status: ready",
      "    depends_on: []",
      "    acceptance_criteria:",
      "      checks:",
      "        - type: shell",
      '          cmd: pnpm e2e --grep "x: y"',
      "          expect_exit: 0",
      "    orchestrator: {}",
      "",
    ].join("\n");
    await fs.writeFile(sprintPath, sprintYaml, "utf8");

    const ctx: ToolContext = {
      projectRoot: root,
      sprintStatusPath: sprintPath,
      configPath: path.join(root, ".sprint-orchestrator", "config.yaml"),
    };

    // The sprint file is intentionally malformed — YAML.parse on the raw doc
    // would either fail or produce a nested mapping. lintSprint depends on
    // readSprintStatus, which calls YAML.parse, so the unquoted cmd from disk
    // either crashes the read or parses to something other than the literal
    // string. Either way, lintSprint must NOT silently accept it.
    //
    // Empirically the yaml lib parses `cmd: pnpm e2e --grep "x: y"` as
    // {cmd: 'pnpm e2e --grep "x', y: 'y"'}, which fails the zod schema. The
    // contract for this story is that an LLM-emitted sprint with that exact
    // wire form is rejected, with a YAML-safety lint issue pointing at the
    // cmd's location.
    //
    // Two acceptable shapes for "rejected": (1) lintSprint throws while
    // parsing, with an error message naming the offending location; or
    // (2) lintSprint succeeds and reports a YAML-safety issue.
    let parseError: Error | null = null;
    let report: Awaited<ReturnType<typeof lintSprint>> | null = null;
    try {
      report = await lintSprint(ctx);
    } catch (err) {
      parseError = err as Error;
    }

    // If the readSprintStatus call swallowed the issue (parsed successfully),
    // verify lintSprint produced the YAML-safety issue on its own. If it
    // crashed, that's still a "reject" — but the integration AC for this
    // story is the in-band issue path, so we additionally drive a second
    // fixture whose cmd parses cleanly but is still YAML-ambiguous on dump.
    const checks: Assertion[] = [
      {
        name: "lintSprint flags shell cmd fields with unquoted YAML-special characters",
        run: async () => {
          // Path B (the in-band one this story is really about): construct a
          // sprint via the safe path (writeSprintStatus → quoted on dump) but
          // mutate the cmd in memory to the dangerous wire form before
          // lintSprint sees it. We do this by writing the fixture using the
          // yaml lib's quoted-style emit so readSprintStatus succeeds, then
          // verify lintSprint still flags it.
          const safeSprintPath = path.join(root, "sprint-status-quoted.yaml");
          const quotedYaml = [
            "schema_version: 1",
            'sprint_id: "lint-yaml-safety-quoted"',
            "stories:",
            '  - id: "Y1"',
            '    title: "cmd quoted at rest, contains YAML-ambiguous chars"',
            "    status: ready",
            "    depends_on: []",
            "    acceptance_criteria:",
            "      checks:",
            "        - type: shell",
            // Quoted on disk so readSprintStatus is happy; the inner string
            // still contains an unquoted-colon-in-flow-context that would
            // break a future round-trip if someone hand-edits the yaml.
            '          cmd: "pnpm e2e --grep \\"x: y\\""',
            "          expect_exit: 0",
            "    orchestrator: {}",
            "",
          ].join("\n");
          await fs.writeFile(safeSprintPath, quotedYaml, "utf8");
          const ctxB: ToolContext = {
            projectRoot: root,
            sprintStatusPath: safeSprintPath,
            configPath: ctx.configPath,
          };
          const reportB = await lintSprint(ctxB, { sprintStatusPath: safeSprintPath });
          const yamlIssue = reportB.issues.find(
            (i) => i.storyId === "Y1" && /YAML-ambiguous/.test(i.message),
          );
          expect(!!yamlIssue, `expected a YAML-safety issue for Y1, got: ${reportB.rendered}`);
          expect(
            yamlIssue!.severity === "error",
            `expected severity=error, got ${yamlIssue!.severity}`,
          );
          expect(
            yamlIssue!.checkIndex === 0,
            `expected checkIndex=0, got ${yamlIssue!.checkIndex}`,
          );
          expect(
            /stories\[Y1\]\.acceptance_criteria\.checks\[0\]\.cmd/.test(yamlIssue!.message),
            `expected message to point at stories[Y1]...checks[0].cmd, got: ${yamlIssue!.message}`,
          );
          // The wire-form path (sprintPath, the unquoted variant) must also
          // be rejected. Either readSprintStatus threw, or lintSprint
          // produced an issue. Anything else is the regression.
          const wireRejected =
            parseError !== null ||
            (report !== null &&
              report.issues.some((i) => i.storyId === "Y1" && /YAML-ambiguous/.test(i.message)));
          expect(
            wireRejected,
            `unquoted-cmd sprint on disk was silently accepted (parseError=${String(
              parseError,
            )}, issues=${JSON.stringify(report?.issues ?? [])})`,
          );
        },
      },
    ];

    for (const a of checks) {
      try {
        await a.run();
        outcomes.push({ name: a.name, passed: true });
        console.log(`  PASS  ${a.name}`);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        outcomes.push({ name: a.name, passed: false, error: msg });
        console.log(`  FAIL  ${a.name}\n        ${msg}`);
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  return outcomes;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const filter = args.grep ? new RegExp(args.grep) : null;

  // Build the mcp-server dist BEFORE setting up the temp repo so we fail
  // fast on a broken build, and so the auto-promotion assertion always
  // exercises the latest src — see ensureDistBuilt() for why this matters.
  ensureDistBuilt();

  const root = await setupTempRepo();
  console.log(`[e2e] temp repo: ${root}`);

  const outcomes: AssertionOutcome[] = [];
  let assertions: Assertion[];
  try {
    assertions = await buildAssertions(root);
  } catch (err) {
    console.error("[e2e] setup/drive failed:", (err as Error).stack ?? String(err));
    if (!args.keep) await fs.rm(root, { recursive: true, force: true });
    return 1;
  }

  const filtered = filter ? assertions.filter((a) => filter.test(a.name)) : assertions;
  // Note: we do NOT bail out here when --grep matches 0 primary assertions —
  // the mini-runs below (opt-out, default_base-stale) run their own
  // assertions and may match the same --grep. The final tally below
  // surfaces a hard failure if 0 assertions total ran.

  for (const a of filtered) {
    try {
      await a.run();
      outcomes.push({ name: a.name, passed: true });
      console.log(`  PASS  ${a.name}`);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      outcomes.push({ name: a.name, passed: false, error: msg });
      console.log(`  FAIL  ${a.name}\n        ${msg}`);
    }
  }

  if (!args.keep) {
    await fs.rm(root, { recursive: true, force: true });
  } else {
    console.log(`[e2e] --keep set; temp repo preserved at ${root}`);
  }

  // Second mini-run: exercise the pr_per_story=false opt-out path. Filtered
  // by the same --grep so `--grep "branch-per-story"` still picks up the
  // primary assertion above without forcing this run, but the default
  // (un-filtered) e2e exercises both.
  if (!filter || filter.test("branch-per-story opt-out")) {
    console.log("[e2e] mini-run: pr_per_story opt-out");
    const optOutOutcomes = await runOptOutMiniRun();
    outcomes.push(...optOutOutcomes);
  }

  // Third mini-run: exercise the stale-default_base refusal path.
  if (!filter || filter.test("refuses when default_base lacks orchestrator schema")) {
    console.log("[e2e] mini-run: default_base-stale refusal");
    const staleOutcomes = await runStaleBaseMiniRun();
    outcomes.push(...staleOutcomes);
  }

  // Fourth mini-run: exercise the cross-session stray-commit guard (story 3).
  if (
    !filter ||
    filter.test("no orchestrator commits appear without a tool call in the current session")
  ) {
    console.log("[e2e] mini-run: cross-session stray-commit guard");
    const strayOutcomes = await runCrossSessionStrayCommitMiniRun();
    outcomes.push(...strayOutcomes);
  }

  // Fifth mini-run: reviewer must escalate to rework (not failure) on the
  // first AC miss when the dev produced new code.
  if (
    !filter ||
    filter.test(
      "reviewer escalates to rework, not failure, on first AC miss after dev produced code",
    )
  ) {
    console.log("[e2e] mini-run: reviewer escalates to rework on first AC miss with dev code");
    const reworkOutcomes = await runReviewerReworkOnFirstACMissMiniRun();
    outcomes.push(...reworkOutcomes);
  }

  // Sixth mini-run: reviewer must return `blocked: <id>` when the MCP server
  // rejects a state-mutating call (and the orchestrator skill must treat that
  // as a hard stop). Guards the cross-session bookkeeping-drift regression
  // from the triage-1 run.
  if (
    !filter ||
    filter.test("reviewer returns blocked status when state machine rejects recordStorySuccess")
  ) {
    console.log("[e2e] mini-run: reviewer returns blocked when state machine rejects mutation");
    const blockedOutcomes = await runReviewerBlockedOnRejectedTransitionMiniRun();
    outcomes.push(...blockedOutcomes);
  }

  // Seventh mini-run: recordStoryReopen recovery path (story 3). Drives a
  // story through to `failed` with rework activity, then reopens it.
  if (
    !filter ||
    filter.test(
      "recordStoryReopen transitions a failed story back to ready and clears failure fields",
    )
  ) {
    console.log("[e2e] mini-run: recordStoryReopen recovery from failed");
    const reopenOutcomes = await runRecordStoryReopenMiniRun();
    outcomes.push(...reopenOutcomes);
  }

  // Eighth mini-run (story 4): lintSprint flags shell cmd fields whose string
  // form is not YAML-safe (would crash a future YAML.parse round-trip).
  if (
    !filter ||
    filter.test("lintSprint flags shell cmd fields with unquoted YAML-special characters")
  ) {
    console.log("[e2e] mini-run: lintSprint YAML-safety check on shell cmd fields");
    const yamlSafetyOutcomes = await runLintSprintYamlSafetyMiniRun();
    outcomes.push(...yamlSafetyOutcomes);
  }

  const failed = outcomes.filter((o) => !o.passed);
  console.log(
    `\n[e2e] ${outcomes.length - failed.length}/${outcomes.length} assertions passed` +
      (filter ? ` (grep=${args.grep})` : ""),
  );
  if (outcomes.length === 0) {
    console.error(`[e2e] --grep ${args.grep} matched 0 assertions across primary + mini-runs`);
    return 1;
  }
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error("[e2e] fatal:", err);
    process.exit(1);
  });
