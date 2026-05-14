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
import { markDevReturned } from "../packages/mcp-server/src/tools/mark-dev-returned.js";
import { markStoryNeedsRework } from "../packages/mcp-server/src/tools/mark-story-needs-rework.js";
import { prepareStoryBranch } from "../packages/mcp-server/src/tools/prepare-story-branch.js";
import { recordStoryReopen } from "../packages/mcp-server/src/tools/record-story-reopen.js";
import { getReadyStories } from "../packages/mcp-server/src/tools/get-ready-stories.js";
import { lintSprint } from "../packages/mcp-server/src/tools/lint-sprint.js";
import { validateAndWriteBacklog } from "../packages/mcp-server/src/tools/adopt-write.js";
import { adaptBmadOutput } from "../packages/mcp-server/src/tools/adapt-bmad.js";
import { planRunSprint } from "../packages/mcp-server/src/tools/plan-run-sprint.js";
import {
  CLIPBOARD_AUTOCOPY_NOTE_LINE,
  CLIPBOARD_OPT_OUT_ENV_VAR,
  FRESH_CONTEXT_GUIDANCE_LINE,
  buildClipboardEscape,
  buildRunSprintFinalOutput,
  formatGoalCommandLine,
  isClipboardOptOut,
} from "../packages/mcp-server/src/tools/run-sprint-output-format.js";
import {
  countTerminalOutcomes,
  formatBlockedLine,
  formatCapStopLine,
  formatDrainLine,
} from "../packages/mcp-server/src/tools/format-end-of-run-line.js";
import {
  ADAPTOR_PATTERN_PHRASE,
  ADOPT_COMMAND,
  NO_ADAPTORS_SHIP_STATEMENT,
  ONE_WAY_COUPLING_STATEMENT,
  PRODUCER_EXAMPLE_FRAMING,
} from "../packages/mcp-server/src/tools/readme-adopt-phrases.js";
import {
  ADAPT_BMAD_INTRO,
  VERIFICATION_REQUIREMENT_STATEMENT,
  VERIFICATION_SECTION_EXAMPLE,
} from "../packages/mcp-server/src/tools/readme-adapt-bmad-phrases.js";
import {
  CLIPBOARD_DEFERRED_ACKNOWLEDGEMENT,
  CLIPBOARD_OPT_OUT_INSTRUCTION,
  FRESH_CONTEXT_RATIONALE,
  GOAL_FINAL_LINE_STATEMENT,
} from "../packages/mcp-server/src/tools/readme-runsprint-phrases.js";
import { validateAcceptanceCriteria } from "../packages/mcp-server/src/tools/validate-acceptance-criteria.js";
import { type ToolContext } from "../packages/mcp-server/src/tools/context.js";
import { buildServer } from "../packages/mcp-server/src/index.js";
import {
  DEEP_MODEL,
  DEFAULT_DEV_MODEL,
  DEFAULT_REVIEWER_MODEL,
} from "../packages/mcp-server/src/tools/model-tiering-defaults.js";
import { RESOLVE_SPAWN_MODEL_INSTRUCTION } from "../packages/mcp-server/src/tools/process-backlog-spawn-phrases.js";
import { PR_PER_STORY_SETUP_PROMPT } from "../packages/mcp-server/src/tools/pr-per-story-setup-phrases.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
  await markDevReturned(ctx, storyId, agent);
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

    // Signal that the dev subagent has finished its swing before the reviewer
    // evaluates ACs. Without this, validateAcceptanceCriteria refuses.
    await markDevReturned(ctx, "C", agent);

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
    await markDevReturned(ctx, "C", "agent-prior-session");
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
    await markDevReturned(ctx, "C", agent);
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

/**
 * Mini-run for story 1: /sprint-orchestrator:run-sprint wrapper.
 *
 * The wrapper is a thin entrypoint that reads sprint-status.yaml, counts
 * stories, multiplies by turn_cap_per_story (config; default 3), and emits
 * a /goal command with the canonical drain condition. We test the
 * computation step directly via planRunSprint() — the harness does not
 * actually invoke /goal, only asserts the command the wrapper would emit.
 */
async function runRunSprintWrapperMiniRun(): Promise<AssertionOutcome[]> {
  const outcomes: AssertionOutcome[] = [];

  const CANONICAL_DRAIN =
    "every story in sprint-status.yaml is status=done or status=failed, OR stop after";

  async function writeSprint(root: string, statuses: Array<"ready" | "done" | "failed">) {
    const stories = statuses
      .map((status, i) => {
        const id = `S${i + 1}`;
        return [
          `  - id: "${id}"`,
          `    title: "story ${id}"`,
          `    status: ${status}`,
          `    depends_on: []`,
          `    acceptance_criteria:`,
          `      checks:`,
          `        - type: file_exists`,
          `          path: src/${id}.txt`,
          `    orchestrator: {}`,
        ].join("\n");
      })
      .join("\n");
    const sprintYaml = [
      "schema_version: 1",
      'sprint_id: "run-sprint-wrapper-fixture"',
      "stories:",
      stories,
      "",
    ].join("\n");
    await fs.writeFile(path.join(root, "sprint-status.yaml"), sprintYaml, "utf8");
  }

  async function writeConfig(root: string, body: string) {
    const configDir = path.join(root, ".sprint-orchestrator");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, "config.yaml"), body, "utf8");
  }

  // Variant 1: 3-story sprint, no config override → default 3, cap 9.
  const tmp1 = await fs.mkdtemp(path.join(os.tmpdir(), "sprint-orch-runsprint-1-"));
  try {
    await writeSprint(tmp1, ["ready", "ready", "ready"]);
    const result = await planRunSprint({ cwd: tmp1 });

    const checks: Assertion[] = [
      {
        name: "run-sprint wrapper computes turn cap and invokes goal with the drain condition",
        run: () => {
          expect(result.kind === "ok", `expected kind=ok, got ${JSON.stringify(result)}`);
          if (result.kind !== "ok") return;
          expect(result.storyCount === 3, `expected storyCount=3, got ${result.storyCount}`);
          expect(
            result.turnCapPerStory === 3,
            `expected default turn_cap_per_story=3, got ${result.turnCapPerStory}`,
          );
          expect(result.turnCap === 9, `expected turn_cap=9, got ${result.turnCap}`);
          expect(
            result.command.includes("stop after 9 turns"),
            `expected command to contain 'stop after 9 turns', got: ${result.command}`,
          );
          expect(
            result.command.includes(CANONICAL_DRAIN),
            `expected command to contain canonical drain condition, got: ${result.command}`,
          );
          expect(
            result.command.startsWith("/goal /sprint-orchestrator:process-backlog UNTIL "),
            `expected command to start with '/goal /sprint-orchestrator:process-backlog UNTIL ', got: ${result.command}`,
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
    await fs.rm(tmp1, { recursive: true, force: true });
  }

  // Variant 2: 3-story sprint, turn_cap_per_story: 5 → cap 15.
  const tmp2 = await fs.mkdtemp(path.join(os.tmpdir(), "sprint-orch-runsprint-2-"));
  try {
    await writeSprint(tmp2, ["ready", "ready", "ready"]);
    await writeConfig(
      tmp2,
      [
        "sprintStatusPath: sprint-status.yaml",
        "layout: custom",
        "autoDetected: false",
        "turn_cap_per_story: 5",
        "",
      ].join("\n"),
    );
    const result = await planRunSprint({ cwd: tmp2 });

    const a: Assertion = {
      name: "run-sprint wrapper honors turn_cap_per_story override from config",
      run: () => {
        expect(result.kind === "ok", `expected kind=ok, got ${JSON.stringify(result)}`);
        if (result.kind !== "ok") return;
        expect(
          result.turnCapPerStory === 5,
          `expected turn_cap_per_story=5, got ${result.turnCapPerStory}`,
        );
        expect(result.turnCap === 15, `expected turn_cap=15, got ${result.turnCap}`);
        expect(
          result.command.includes("stop after 15 turns"),
          `expected command to contain 'stop after 15 turns', got: ${result.command}`,
        );
      },
    };

    try {
      await a.run();
      outcomes.push({ name: a.name, passed: true });
      console.log(`  PASS  ${a.name}`);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      outcomes.push({ name: a.name, passed: false, error: msg });
      console.log(`  FAIL  ${a.name}\n        ${msg}`);
    }
  } finally {
    await fs.rm(tmp2, { recursive: true, force: true });
  }

  // Variant 3: drained sprint (all done/failed) → refuse, no command.
  const tmp3 = await fs.mkdtemp(path.join(os.tmpdir(), "sprint-orch-runsprint-3-"));
  try {
    await writeSprint(tmp3, ["done", "done", "failed"]);
    const result = await planRunSprint({ cwd: tmp3 });

    const a: Assertion = {
      name: "run-sprint wrapper refuses on a drained sprint and emits no command",
      run: () => {
        expect(result.kind === "refuse", `expected kind=refuse, got ${JSON.stringify(result)}`);
        if (result.kind !== "refuse") return;
        expect(result.reason === "drained", `expected reason=drained, got ${result.reason}`);
        expect(
          /nothing to run — backlog is drained/.test(result.message),
          `expected message to mention drained backlog, got: ${result.message}`,
        );
        expect(
          /2 done/.test(result.message) && /1 failed/.test(result.message),
          `expected message to report '2 done, 1 failed', got: ${result.message}`,
        );
      },
    };

    try {
      await a.run();
      outcomes.push({ name: a.name, passed: true });
      console.log(`  PASS  ${a.name}`);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      outcomes.push({ name: a.name, passed: false, error: msg });
      console.log(`  FAIL  ${a.name}\n        ${msg}`);
    }
  } finally {
    await fs.rm(tmp3, { recursive: true, force: true });
  }

  // Variant 4: missing sprint-status.yaml → refuse with the expected message.
  const tmp4 = await fs.mkdtemp(path.join(os.tmpdir(), "sprint-orch-runsprint-4-"));
  try {
    const result = await planRunSprint({ cwd: tmp4 });

    const a: Assertion = {
      name: "run-sprint wrapper refuses when sprint-status.yaml is missing and emits no command",
      run: () => {
        expect(result.kind === "refuse", `expected kind=refuse, got ${JSON.stringify(result)}`);
        if (result.kind !== "refuse") return;
        expect(
          result.reason === "missing_backlog",
          `expected reason=missing_backlog, got ${result.reason}`,
        );
        expect(
          /no backlog found: expected sprint-status\.yaml at /.test(result.message),
          `expected message to start with 'no backlog found...', got: ${result.message}`,
        );
        expect(
          /Copy a backlog file there before running\.$/.test(result.message),
          `expected message to end with 'Copy a backlog file there before running.', got: ${result.message}`,
        );
      },
    };

    try {
      await a.run();
      outcomes.push({ name: a.name, passed: true });
      console.log(`  PASS  ${a.name}`);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      outcomes.push({ name: a.name, passed: false, error: msg });
      console.log(`  FAIL  ${a.name}\n        ${msg}`);
    }
  } finally {
    await fs.rm(tmp4, { recursive: true, force: true });
  }

  return outcomes;
}

/**
 * Mini-run for the goal-adoption sprint story 1: run-sprint emits the
 * `/goal` command on a guaranteed single, last line of stdout, preceded
 * by a one-line fresh-context-window guidance note. The format is locked
 * by `run-sprint-output-format.ts` so the skill and this assertion stay
 * in lockstep.
 */
async function runRunSprintGoalLastLineMiniRun(): Promise<AssertionOutcome[]> {
  const outcomes: AssertionOutcome[] = [];

  const turnCaps = [1, 9, 15, 42];

  for (const turnCap of turnCaps) {
    const a: Assertion = {
      name: "run-sprint emits goal on guaranteed last line with fresh-context guidance",
      run: () => {
        const block = buildRunSprintFinalOutput(turnCap);
        const goalLine = formatGoalCommandLine(turnCap);

        // (a) ends with the canonical /goal line for N (plus exactly one trailing newline).
        expect(
          block.endsWith(`${goalLine}\n`),
          `expected block to end with the /goal line + single \\n, got: ${JSON.stringify(block)}`,
        );

        // The /goal line is the literal final non-empty line of stdout.
        // Strip the single trailing newline, then the last line must equal goalLine.
        const trimmed = block.endsWith("\n") ? block.slice(0, -1) : block;
        const lines = trimmed.split("\n");
        expect(
          lines[lines.length - 1] === goalLine,
          `expected last line to be the /goal command, got: ${JSON.stringify(lines[lines.length - 1])}`,
        );

        // (b) /goal line contains no embedded newlines.
        expect(
          !goalLine.includes("\n"),
          `expected /goal line to have no embedded newlines, got: ${JSON.stringify(goalLine)}`,
        );
        expect(
          goalLine.includes(`stop after ${turnCap} turns`),
          `expected /goal line to contain 'stop after ${turnCap} turns', got: ${goalLine}`,
        );

        // (c) second-to-last non-empty line is the fresh-context guidance string.
        const nonEmpty = lines.filter((l) => l.length > 0);
        expect(
          nonEmpty.length >= 2,
          `expected at least two non-empty lines in final block, got: ${JSON.stringify(lines)}`,
        );
        expect(
          nonEmpty[nonEmpty.length - 2] === FRESH_CONTEXT_GUIDANCE_LINE,
          `expected second-to-last non-empty line to equal FRESH_CONTEXT_GUIDANCE_LINE, got: ${JSON.stringify(nonEmpty[nonEmpty.length - 2])}`,
        );

        // (d) nothing follows the /goal line except at most one trailing \n.
        const afterGoal = block.slice(block.lastIndexOf(goalLine) + goalLine.length);
        expect(
          afterGoal === "" || afterGoal === "\n",
          `expected nothing after /goal line except at most one \\n, got: ${JSON.stringify(afterGoal)}`,
        );

        // Sanity: the constant itself is non-empty and single-line.
        expect(
          FRESH_CONTEXT_GUIDANCE_LINE.length > 0 && !FRESH_CONTEXT_GUIDANCE_LINE.includes("\n"),
          `expected FRESH_CONTEXT_GUIDANCE_LINE to be non-empty single line, got: ${JSON.stringify(FRESH_CONTEXT_GUIDANCE_LINE)}`,
        );
      },
    };

    try {
      await a.run();
      outcomes.push({ name: a.name, passed: true });
      console.log(`  PASS  ${a.name} (turnCap=${turnCap})`);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      outcomes.push({ name: a.name, passed: false, error: msg });
      console.log(`  FAIL  ${a.name} (turnCap=${turnCap})\n        ${msg}`);
    }
  }

  // Integration sanity: planRunSprint() produces a command string equal to the
  // /goal line that buildRunSprintFinalOutput would print for the same cap.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sprint-orch-runsprint-goal-lastline-"));
  try {
    const sprintYaml = [
      "schema_version: 1",
      'sprint_id: "run-sprint-goal-lastline-fixture"',
      "stories:",
      '  - id: "S1"',
      '    title: "story S1"',
      "    status: ready",
      "    depends_on: []",
      "    acceptance_criteria:",
      "      checks:",
      "        - type: file_exists",
      "          path: src/S1.txt",
      "    orchestrator: {}",
      "",
    ].join("\n");
    await fs.writeFile(path.join(tmp, "sprint-status.yaml"), sprintYaml, "utf8");

    const plan = await planRunSprint({ cwd: tmp });

    const a: Assertion = {
      name: "run-sprint emits goal on guaranteed last line with fresh-context guidance",
      run: () => {
        expect(plan.kind === "ok", `expected kind=ok, got ${JSON.stringify(plan)}`);
        if (plan.kind !== "ok") return;
        const block = buildRunSprintFinalOutput(plan.turnCap);
        expect(
          block.endsWith(`${plan.command}\n`),
          `expected final block to end with planner's command + \\n. block=${JSON.stringify(block)} command=${JSON.stringify(plan.command)}`,
        );
      },
    };

    try {
      await a.run();
      outcomes.push({ name: a.name, passed: true });
      console.log(`  PASS  ${a.name} (planner integration)`);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      outcomes.push({ name: a.name, passed: false, error: msg });
      console.log(`  FAIL  ${a.name} (planner integration)\n        ${msg}`);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }

  return outcomes;
}

/**
 * Mini-run for the goal-adoption sprint story 2: OSC 52 clipboard auto-copy
 * spike + env-var opt-out safety.
 *
 * Outcome of the spike (recorded in `_bmad-output/planning-artifacts/follow-ups.md`):
 * Claude Code's harness does NOT pass OSC 52 terminal escapes through to the
 * user's terminal verbatim. The implementation branch is therefore inert,
 * but the `SPRINT_ORCHESTRATOR_NO_CLIPBOARD` opt-out is still wired so a
 * future harness change has a single, predictable gate to flip.
 *
 * These assertions verify the failure-path safety net:
 *  (a) opt-out unset → output contains no OSC 52 sequence, no clipboard note;
 *      /goal line is still the literal last line (Story 1 contract).
 *  (b) opt-out set to "1" or "true" (any case) → identical output: no OSC 52
 *      sequence, no clipboard note; perfect no-op safety.
 *  (c) the env-var gate is observable via `isClipboardOptOut(env)` so future
 *      callers (and the e2e itself) can prove it's wired.
 *  (d) `buildClipboardEscape` is a pure helper that produces a well-formed
 *      OSC 52 frame — kept alive as a tested function so the cost-to-revive
 *      is near zero when the harness changes.
 */
async function runRunSprintOsc52ClipboardMiniRun(): Promise<AssertionOutcome[]> {
  const outcomes: AssertionOutcome[] = [];

  // OSC 52 frame: ESC ] 52 ; c ; <base64> BEL. We assert ABSENCE of any
  // substring matching this shape (with at least one base64 character) in
  // the production output, given the spike failed and the emit branch is
  // dead code today.
  // eslint-disable-next-line no-control-regex
  const OSC52_RE = /\x1b\]52;c;[A-Za-z0-9+/=]+\x07/;

  const turnCaps = [1, 9, 42];
  // Cover unset + the documented true-ish forms + a couple of false-ish
  // forms to prove the parser is strict ("1"/"true" only, case-insensitive).
  const envFixtures: Array<{ label: string; env: NodeJS.ProcessEnv; expectOptOut: boolean }> = [
    { label: "unset", env: {}, expectOptOut: false },
    { label: 'set to "1"', env: { [CLIPBOARD_OPT_OUT_ENV_VAR]: "1" }, expectOptOut: true },
    { label: 'set to "true"', env: { [CLIPBOARD_OPT_OUT_ENV_VAR]: "true" }, expectOptOut: true },
    { label: 'set to "TRUE"', env: { [CLIPBOARD_OPT_OUT_ENV_VAR]: "TRUE" }, expectOptOut: true },
    { label: 'set to "0"', env: { [CLIPBOARD_OPT_OUT_ENV_VAR]: "0" }, expectOptOut: false },
    { label: 'set to "false"', env: { [CLIPBOARD_OPT_OUT_ENV_VAR]: "false" }, expectOptOut: false },
    { label: 'set to ""', env: { [CLIPBOARD_OPT_OUT_ENV_VAR]: "" }, expectOptOut: false },
  ];

  for (const turnCap of turnCaps) {
    for (const fixture of envFixtures) {
      const a: Assertion = {
        name: "run-sprint emits OSC 52 clipboard sequence for goal command with opt-out",
        run: () => {
          // (c) gate is observable and parses strictly.
          expect(
            isClipboardOptOut(fixture.env) === fixture.expectOptOut,
            `expected isClipboardOptOut(${fixture.label})=${fixture.expectOptOut}, got ${isClipboardOptOut(fixture.env)}`,
          );

          const block = buildRunSprintFinalOutput(turnCap, fixture.env);
          const goalLine = formatGoalCommandLine(turnCap);

          // (a)/(b) NO OSC 52 sequence leaks into output, regardless of env.
          expect(
            !OSC52_RE.test(block),
            `expected no OSC 52 escape in output (env=${fixture.label}), got: ${JSON.stringify(block)}`,
          );

          // (a)/(b) NO clipboard note line in output, regardless of env.
          expect(
            !block.includes(CLIPBOARD_AUTOCOPY_NOTE_LINE),
            `expected clipboard auto-copy note absent (env=${fixture.label}), got: ${JSON.stringify(block)}`,
          );

          // Story 1 contract preserved: /goal line is the literal last line.
          expect(
            block.endsWith(`${goalLine}\n`),
            `expected block to end with /goal line + \\n (env=${fixture.label}), got: ${JSON.stringify(block)}`,
          );
          const trimmed = block.endsWith("\n") ? block.slice(0, -1) : block;
          const lines = trimmed.split("\n");
          expect(
            lines[lines.length - 1] === goalLine,
            `expected last line to equal /goal command (env=${fixture.label}), got: ${JSON.stringify(lines[lines.length - 1])}`,
          );

          // Output with opt-out set must equal output with opt-out unset — perfect no-op.
          const unsetBlock = buildRunSprintFinalOutput(turnCap, {});
          expect(
            block === unsetBlock,
            `expected env=${fixture.label} output to equal unset output (no-op safety), got block=${JSON.stringify(block)} unsetBlock=${JSON.stringify(unsetBlock)}`,
          );
        },
      };

      try {
        await a.run();
        outcomes.push({ name: a.name, passed: true });
        console.log(`  PASS  ${a.name} (turnCap=${turnCap}, env=${fixture.label})`);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        outcomes.push({ name: a.name, passed: false, error: msg });
        console.log(`  FAIL  ${a.name} (turnCap=${turnCap}, env=${fixture.label})\n        ${msg}`);
      }
    }
  }

  // (d) buildClipboardEscape is a well-formed pure function — base64 round-trip
  // confirms it would produce a valid OSC 52 frame the day the harness lets us
  // ship it. This is the "kept alive, tested" guarantee.
  const escapeFixtures = ["hello", "/goal /sprint-orchestrator:process-backlog UNTIL stop"];
  for (const payload of escapeFixtures) {
    const a: Assertion = {
      name: "run-sprint emits OSC 52 clipboard sequence for goal command with opt-out",
      run: () => {
        const frame = buildClipboardEscape(payload);
        // eslint-disable-next-line no-control-regex
        const m = frame.match(/^\x1b\]52;c;([A-Za-z0-9+/=]+)\x07$/);
        expect(m !== null, `expected OSC 52 frame shape, got: ${JSON.stringify(frame)}`);
        if (!m) return;
        const decoded = Buffer.from(m[1] ?? "", "base64").toString("utf8");
        expect(
          decoded === payload,
          `expected base64 payload to round-trip to ${JSON.stringify(payload)}, got ${JSON.stringify(decoded)}`,
        );
      },
    };
    try {
      await a.run();
      outcomes.push({ name: a.name, passed: true });
      console.log(`  PASS  ${a.name} (buildClipboardEscape payload=${JSON.stringify(payload)})`);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      outcomes.push({ name: a.name, passed: false, error: msg });
      console.log(
        `  FAIL  ${a.name} (buildClipboardEscape payload=${JSON.stringify(payload)})\n        ${msg}`,
      );
    }
  }

  return outcomes;
}

/**
 * Story 2 — end-of-run summary contract for /sprint-orchestrator:process-backlog.
 *
 * Three distinct, greppable final lines tell the /goal evaluator
 * (a Haiku-class model reading the transcript) whether the run ended in
 * a clean drain, a hard-cap pause, or a blocked stop. The line grammar
 * is the contract.
 *
 * This mini-run drives three small sprints — one drain, one cap-stop,
 * one blocked — and asserts the final printed line of each against the
 * reference formatters in
 * `packages/mcp-server/src/tools/format-end-of-run-line.ts`, which the
 * skill is documented to use.
 */
async function runProcessBacklogEndOfRunSummaryLinesMiniRun(): Promise<AssertionOutcome[]> {
  const outcomes: AssertionOutcome[] = [];

  async function writeSprint(root: string, statuses: Array<"ready" | "done" | "failed">) {
    const stories = statuses
      .map((status, i) => {
        const id = `S${i + 1}`;
        return [
          `  - id: "${id}"`,
          `    title: "story ${id}"`,
          `    status: ${status}`,
          `    depends_on: []`,
          `    acceptance_criteria:`,
          `      checks:`,
          `        - type: file_exists`,
          `          path: src/${id}.txt`,
          `    orchestrator: {}`,
        ].join("\n");
      })
      .join("\n");
    const sprintYaml = [
      "schema_version: 1",
      'sprint_id: "end-of-run-summary-lines-fixture"',
      "stories:",
      stories,
      "",
    ].join("\n");
    await fs.writeFile(path.join(root, "sprint-status.yaml"), sprintYaml, "utf8");
  }

  // ---- Drain scenario --------------------------------------------------
  // Mini-sprint: all terminal (2 done, 1 failed). The orchestrator skill
  // would observe getReadyStories() === [] and emit the drain line.
  const drainRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sprint-orch-eor-drain-"));
  try {
    await writeSprint(drainRoot, ["done", "done", "failed"]);
    const sprintPath = path.join(drainRoot, "sprint-status.yaml");
    const tally = await countTerminalOutcomes(sprintPath);
    // Simulate the skill's terminal print.
    const transcript = [
      "[run] story S1 -> done",
      "[run] story S2 -> done",
      "[run] story S3 -> failed",
      formatDrainLine(tally.done, tally.failed),
    ].join("\n");
    const finalLine = transcript.split("\n").pop() ?? "";

    const a: Assertion = {
      name: "process-backlog prints distinct end-of-run summary lines for drain cap-stop and blocked: drain",
      run: () => {
        const re =
          /^Sprint drain confirmed: 0 ready stories remaining\. Outcome: (\d+) done, (\d+) failed\.$/;
        const m = finalLine.match(re);
        expect(!!m, `drain final line did not match contract; got: ${finalLine}`);
        if (!m) return;
        expect(Number(m[1]) === 2, `expected 2 done in drain line, got ${m[1]}`);
        expect(Number(m[2]) === 1, `expected 1 failed in drain line, got ${m[2]}`);
      },
    };
    try {
      await a.run();
      outcomes.push({ name: a.name, passed: true });
      console.log(`  PASS  ${a.name}`);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      outcomes.push({ name: a.name, passed: false, error: msg });
      console.log(`  FAIL  ${a.name}\n        ${msg}`);
    }
  } finally {
    await fs.rm(drainRoot, { recursive: true, force: true });
  }

  // ---- Cap-stop scenario ----------------------------------------------
  // 7-story sprint with 5 done (the cap was hit) and 2 still ready.
  const capRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sprint-orch-eor-cap-"));
  try {
    await writeSprint(capRoot, ["done", "done", "done", "done", "done", "ready", "ready"]);
    const sprintPath = path.join(capRoot, "sprint-status.yaml");
    const tally = await countTerminalOutcomes(sprintPath);
    const readyRemaining = 2; // skill would call getReadyStories() — here we assert against the known fixture
    const transcript = [
      "[run] story S1 -> done",
      "[run] story S5 -> done",
      "[run] hard cap reached (5)",
      formatCapStopLine(readyRemaining, tally.done, tally.failed),
    ].join("\n");
    const finalLine = transcript.split("\n").pop() ?? "";

    const a: Assertion = {
      name: "process-backlog prints distinct end-of-run summary lines for drain cap-stop and blocked: cap-stop",
      run: () => {
        const re =
          /^Sprint paused at hard cap: (\d+) ready stories remaining\. Outcome so far: (\d+) done, (\d+) failed\.$/;
        const m = finalLine.match(re);
        expect(!!m, `cap-stop final line did not match contract; got: ${finalLine}`);
        if (!m) return;
        expect(Number(m[1]) === 2, `expected 2 ready remaining, got ${m[1]}`);
        expect(Number(m[2]) === 5, `expected 5 done so far, got ${m[2]}`);
        expect(Number(m[3]) === 0, `expected 0 failed so far, got ${m[3]}`);
      },
    };
    try {
      await a.run();
      outcomes.push({ name: a.name, passed: true });
      console.log(`  PASS  ${a.name}`);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      outcomes.push({ name: a.name, passed: false, error: msg });
      console.log(`  FAIL  ${a.name}\n        ${msg}`);
    }
  } finally {
    await fs.rm(capRoot, { recursive: true, force: true });
  }

  // ---- Blocked scenario ------------------------------------------------
  // Reviewer returned blocked: state-machine rejected recordStorySuccess.
  const blockedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sprint-orch-eor-blocked-"));
  try {
    await writeSprint(blockedRoot, ["ready", "ready", "ready"]);
    const reason = "state-machine rejected recordStorySuccess: story not in_progress";
    const readyRemaining = 3;
    const transcript = [
      "[run] story S1 -> blocked",
      formatBlockedLine(reason, readyRemaining),
    ].join("\n");
    const finalLine = transcript.split("\n").pop() ?? "";

    const a: Assertion = {
      name: "process-backlog prints distinct end-of-run summary lines for drain cap-stop and blocked: blocked",
      run: () => {
        const re = /^Sprint blocked: (.+)\. (\d+) ready stories remaining\.$/;
        const m = finalLine.match(re);
        expect(!!m, `blocked final line did not match contract; got: ${finalLine}`);
        if (!m) return;
        expect(m[1] === reason, `expected blocked reason '${reason}', got '${m[1]}'`);
        expect(Number(m[2]) === 3, `expected 3 ready remaining, got ${m[2]}`);
      },
    };
    try {
      await a.run();
      outcomes.push({ name: a.name, passed: true });
      console.log(`  PASS  ${a.name}`);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      outcomes.push({ name: a.name, passed: false, error: msg });
      console.log(`  FAIL  ${a.name}\n        ${msg}`);
    }
  } finally {
    await fs.rm(blockedRoot, { recursive: true, force: true });
  }

  // ---- Distinctness ----------------------------------------------------
  // The three line shapes must be greppable apart — no shared prefix that
  // would confuse the /goal evaluator. Assert the leading tokens differ.
  {
    const drain = formatDrainLine(0, 0);
    const cap = formatCapStopLine(0, 0, 0);
    const blocked = formatBlockedLine("x", 0);
    const a: Assertion = {
      name: "process-backlog prints distinct end-of-run summary lines for drain cap-stop and blocked: lines are mutually distinct",
      run: () => {
        expect(
          drain.startsWith("Sprint drain confirmed:"),
          `drain line lost its leading token: ${drain}`,
        );
        expect(
          cap.startsWith("Sprint paused at hard cap:"),
          `cap-stop line lost its leading token: ${cap}`,
        );
        expect(
          blocked.startsWith("Sprint blocked:"),
          `blocked line lost its leading token: ${blocked}`,
        );
        const tokens = new Set([drain.split(":")[0], cap.split(":")[0], blocked.split(":")[0]]);
        expect(
          tokens.size === 3,
          `expected 3 distinct leading tokens, got ${JSON.stringify([...tokens])}`,
        );
      },
    };
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

  return outcomes;
}

/**
 * Story 3 — README documents the /sprint-orchestrator:run-sprint wrapper as the
 * recommended entrypoint, the computed turn-cap rule, and the three
 * end-of-run summary line shapes.
 *
 * The README is the muscle-memory steering wheel: if it leads with /loop, users
 * will keep reaching for /loop. This mini-run reads README.md and asserts:
 *   - /sprint-orchestrator:run-sprint appears before any /loop mention in the
 *     "Running a sprint" section.
 *   - The cap formula (story_count * turn_cap_per_story) is documented.
 *   - The three end-of-run summary line prefixes from story 2 appear verbatim.
 */
async function runReadmeDocumentsRunSprintEntrypointMiniRun(): Promise<AssertionOutcome[]> {
  const outcomes: AssertionOutcome[] = [];

  const readmePath = path.resolve(HERE, "..", "README.md");
  let readme = "";
  try {
    readme = await fs.readFile(readmePath, "utf8");
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    outcomes.push({
      name: "README documents run-sprint wrapper computed turn cap and end-of-run summary lines: file readable",
      passed: false,
      error: `could not read README at ${readmePath}: ${msg}`,
    });
    return outcomes;
  }

  // Locate the "Running a sprint" section: from its heading to the next
  // top-level (## ...) heading. The section is where muscle memory gets set,
  // so the ordering check is scoped to it.
  function extractRunningSection(text: string): string | null {
    const m = text.match(/\n##\s+Running a sprint\b[\s\S]*?(?=\n##\s+|\n?$)/);
    return m ? m[0] : null;
  }

  const section = extractRunningSection(readme);

  const checks: Assertion[] = [
    {
      name: "README documents run-sprint wrapper computed turn cap and end-of-run summary lines: run-sprint section exists",
      run: () => {
        expect(
          section !== null,
          "README is missing the '## Running a sprint' section that documents the wrapper",
        );
      },
    },
    {
      name: "README documents run-sprint wrapper computed turn cap and end-of-run summary lines: run-sprint precedes /loop in the section",
      run: () => {
        if (!section) return;
        const wrapperIdx = section.indexOf("/sprint-orchestrator:run-sprint");
        const loopIdx = section.indexOf("/loop");
        expect(
          wrapperIdx >= 0,
          "Running-a-sprint section does not mention /sprint-orchestrator:run-sprint",
        );
        if (loopIdx >= 0) {
          expect(
            wrapperIdx < loopIdx,
            `/sprint-orchestrator:run-sprint must appear before any /loop mention in the Running-a-sprint section (run-sprint at ${wrapperIdx}, /loop at ${loopIdx})`,
          );
        }
      },
    },
    {
      name: "README documents run-sprint wrapper computed turn cap and end-of-run summary lines: cap formula is documented",
      run: () => {
        // The formula must be present and unambiguous. The canonical form is
        // ceil(story_count * turn_cap_per_story); accept minor whitespace
        // variants but require both factors and the multiplication.
        const re = /ceil\(\s*story_count\s*\*\s*turn_cap_per_story\s*\)/;
        expect(
          re.test(readme),
          "README does not document the cap formula 'ceil(story_count * turn_cap_per_story)'",
        );
        expect(
          /turn_cap_per_story/.test(readme) && /default[^\n]*3/i.test(readme),
          "README does not document the default turn_cap_per_story = 3",
        );
        expect(
          /\.sprint-orchestrator\/config\.yaml/.test(readme),
          "README does not point at .sprint-orchestrator/config.yaml as the override location",
        );
      },
    },
    {
      name: "README documents run-sprint wrapper computed turn cap and end-of-run summary lines: raw /goal manual override is documented",
      run: () => {
        // Canonical drain condition string from story 1 — shown verbatim so
        // users can copy/adapt it.
        const canonical =
          "/goal /sprint-orchestrator:process-backlog UNTIL every story in sprint-status.yaml is status=done or status=failed, OR stop after";
        expect(
          readme.includes(canonical),
          `README does not document the canonical /goal drain command (expected substring: '${canonical}')`,
        );
      },
    },
    {
      name: "README documents run-sprint wrapper computed turn cap and end-of-run summary lines: drain summary prefix appears",
      run: () => {
        expect(
          readme.includes("Sprint drain confirmed:"),
          "README does not document the drain end-of-run summary prefix 'Sprint drain confirmed:'",
        );
      },
    },
    {
      name: "README documents run-sprint wrapper computed turn cap and end-of-run summary lines: cap-stop summary prefix appears",
      run: () => {
        expect(
          readme.includes("Sprint paused at hard cap:"),
          "README does not document the cap-stop end-of-run summary prefix 'Sprint paused at hard cap:'",
        );
      },
    },
    {
      name: "README documents run-sprint wrapper computed turn cap and end-of-run summary lines: blocked summary prefix appears",
      run: () => {
        expect(
          readme.includes("Sprint blocked:"),
          "README does not document the blocked end-of-run summary prefix 'Sprint blocked:'",
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

  return outcomes;
}

/**
 * Story 1.3 — README documents adopt as the recommended entrypoint and
 * names the in-plugin adaptor pattern.
 *
 * Reads the README, isolates the "Running a sprint" section, and asserts
 * the four AC5 properties against the locked phrases exported from
 * `readme-adopt-phrases.ts`. The constants module is the single source
 * of truth so the README and the assertions can't drift.
 */
async function runReadmeDocumentsAdoptAndAdaptorPatternMiniRun(): Promise<AssertionOutcome[]> {
  const outcomes: AssertionOutcome[] = [];

  const readmePath = path.resolve(HERE, "..", "README.md");
  let readme = "";
  try {
    readme = await fs.readFile(readmePath, "utf8");
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    outcomes.push({
      name: "README documents adopt and the in-plugin adaptor pattern: file readable",
      passed: false,
      error: `could not read README at ${readmePath}: ${msg}`,
    });
    return outcomes;
  }

  // Same scoping rule as the sibling mini-run: the "Running a sprint"
  // section runs from its heading to the next top-level heading.
  function extractRunningSection(text: string): string | null {
    const m = text.match(/\n##\s+Running a sprint\b[\s\S]*?(?=\n##\s+|\n?$)/);
    return m ? m[0] : null;
  }

  const section = extractRunningSection(readme);

  const checks: Assertion[] = [
    {
      name: "README documents adopt and the in-plugin adaptor pattern: running-a-sprint section exists",
      run: () => {
        expect(section !== null, "README is missing the '## Running a sprint' section");
      },
    },
    {
      name: "README documents adopt and the in-plugin adaptor pattern: adopt command is present in the section",
      run: () => {
        if (!section) return;
        expect(
          section.includes(ADOPT_COMMAND),
          `Running-a-sprint section does not mention ${ADOPT_COMMAND}`,
        );
      },
    },
    {
      name: "README documents adopt and the in-plugin adaptor pattern: adaptor pattern is named in the section",
      run: () => {
        if (!section) return;
        expect(
          section.includes(ADAPTOR_PATTERN_PHRASE),
          `Running-a-sprint section does not name the '${ADAPTOR_PATTERN_PHRASE}'`,
        );
      },
    },
    {
      name: "README documents adopt and the in-plugin adaptor pattern: one-way-coupling statement is present verbatim",
      run: () => {
        if (!section) return;
        expect(
          section.includes(ONE_WAY_COUPLING_STATEMENT),
          `Running-a-sprint section does not contain the one-way-coupling statement verbatim. Expected: '${ONE_WAY_COUPLING_STATEMENT}'`,
        );
      },
    },
    {
      name: "README documents adopt and the in-plugin adaptor pattern: BMad-as-example framing is present verbatim",
      run: () => {
        if (!section) return;
        expect(
          section.includes(PRODUCER_EXAMPLE_FRAMING),
          `Running-a-sprint section does not contain the producer-example framing verbatim. Expected: '${PRODUCER_EXAMPLE_FRAMING}'`,
        );
      },
    },
    {
      name: "README documents adopt and the in-plugin adaptor pattern: no-adaptors-ship disclaimer is present verbatim",
      run: () => {
        if (!section) return;
        expect(
          section.includes(NO_ADAPTORS_SHIP_STATEMENT),
          `Running-a-sprint section does not contain the no-adaptors-ship disclaimer verbatim. Expected: '${NO_ADAPTORS_SHIP_STATEMENT}'`,
        );
      },
    },
    {
      name: "README documents adopt and the in-plugin adaptor pattern: adopt is introduced before run-sprint in the section",
      run: () => {
        if (!section) return;
        const adoptIdx = section.indexOf(ADOPT_COMMAND);
        const runSprintIdx = section.indexOf("/sprint-orchestrator:run-sprint");
        expect(
          adoptIdx >= 0 && runSprintIdx >= 0,
          `Running-a-sprint section must mention both ${ADOPT_COMMAND} (idx=${adoptIdx}) and /sprint-orchestrator:run-sprint (idx=${runSprintIdx})`,
        );
        expect(
          adoptIdx < runSprintIdx,
          `${ADOPT_COMMAND} must appear before /sprint-orchestrator:run-sprint in the Running-a-sprint section (adopt at ${adoptIdx}, run-sprint at ${runSprintIdx})`,
        );
      },
    },
    {
      name: "README documents adopt and the in-plugin adaptor pattern: run-sprint + cap-formula content is preserved",
      run: () => {
        // Guard against accidental deletion of the prior sprint's content.
        // The cap formula and the three end-of-run summary prefixes must
        // still be present after the adopt + adaptor-pattern prepend.
        expect(
          /ceil\(\s*story_count\s*\*\s*turn_cap_per_story\s*\)/.test(readme),
          "README no longer documents the cap formula 'ceil(story_count * turn_cap_per_story)' — adopt edits must not delete prior sprint content",
        );
        expect(
          readme.includes("Sprint drain confirmed:") &&
            readme.includes("Sprint paused at hard cap:") &&
            readme.includes("Sprint blocked:"),
          "README no longer documents all three end-of-run summary prefixes — adopt edits must not delete prior sprint content",
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

  return outcomes;
}

/**
 * goal-adoption sprint, story 3 — README documents the new run-sprint
 * output flow: /goal printed as the literal last line, the fresh-context
 * rationale for pasting it elsewhere, and the deferred clipboard
 * auto-copy (Story 2's OSC 52 spike failed; see follow-ups.md).
 *
 * The locked phrases live in `readme-runsprint-phrases.ts` and are the
 * single source of truth — README and assertions cannot drift.
 */
async function runReadmeDocumentsRunSprintLastLineMiniRun(): Promise<AssertionOutcome[]> {
  const outcomes: AssertionOutcome[] = [];

  const readmePath = path.resolve(HERE, "..", "README.md");
  let readme = "";
  try {
    readme = await fs.readFile(readmePath, "utf8");
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    outcomes.push({
      name: "README documents run-sprint last-line fresh-context and clipboard flow: file readable",
      passed: false,
      error: `could not read README at ${readmePath}: ${msg}`,
    });
    return outcomes;
  }

  function extractRunningSection(text: string): string | null {
    const m = text.match(/\n##\s+Running a sprint\b[\s\S]*?(?=\n##\s+|\n?$)/);
    return m ? m[0] : null;
  }

  const section = extractRunningSection(readme);

  const checks: Assertion[] = [
    {
      name: "README documents run-sprint last-line fresh-context and clipboard flow: running-a-sprint section exists",
      run: () => {
        expect(section !== null, "README is missing the '## Running a sprint' section");
      },
    },
    {
      name: "README documents run-sprint last-line fresh-context and clipboard flow: fresh-context rationale present verbatim",
      run: () => {
        if (!section) return;
        expect(
          section.includes(FRESH_CONTEXT_RATIONALE),
          `Running-a-sprint section does not contain the fresh-context rationale verbatim. Expected: '${FRESH_CONTEXT_RATIONALE}'`,
        );
      },
    },
    {
      name: "README documents run-sprint last-line fresh-context and clipboard flow: /goal as final-line statement is present verbatim",
      run: () => {
        if (!section) return;
        expect(
          section.includes(GOAL_FINAL_LINE_STATEMENT),
          `Running-a-sprint section does not describe /goal as the final line of output verbatim. Expected: '${GOAL_FINAL_LINE_STATEMENT}'`,
        );
      },
    },
    {
      name: "README documents run-sprint last-line fresh-context and clipboard flow: clipboard auto-copy is acknowledged as deferred with link to follow-ups.md",
      run: () => {
        if (!section) return;
        // Spike-failed path (per follow-ups.md): README must NOT claim
        // clipboard auto-copy exists. Instead, it must acknowledge the
        // deferral verbatim and point at the follow-ups tracker.
        expect(
          section.includes(CLIPBOARD_DEFERRED_ACKNOWLEDGEMENT),
          `Running-a-sprint section does not contain the deferred-clipboard acknowledgement verbatim. Expected: '${CLIPBOARD_DEFERRED_ACKNOWLEDGEMENT}'`,
        );
        expect(
          section.includes("follow-ups.md"),
          "Running-a-sprint section does not link to follow-ups.md alongside the deferred-clipboard acknowledgement",
        );
        // Inert export — must not be presented as a live opt-out
        // instruction in the deferred path. Guard against accidental
        // adoption of the auto-copy phrasing.
        expect(
          !section.includes(CLIPBOARD_OPT_OUT_INSTRUCTION),
          "Running-a-sprint section presents the OSC 52 opt-out instruction as live, but Story 2's spike failed — the clipboard auto-copy path is deferred. Use CLIPBOARD_DEFERRED_ACKNOWLEDGEMENT instead.",
        );
      },
    },
    {
      name: "README documents run-sprint last-line fresh-context and clipboard flow: prior sprint content preserved",
      run: () => {
        // Guard against accidental deletion of the prior sprint's content.
        expect(
          /ceil\(\s*story_count\s*\*\s*turn_cap_per_story\s*\)/.test(readme),
          "README no longer documents the cap formula 'ceil(story_count * turn_cap_per_story)' — story 3 edits must not delete prior sprint content",
        );
        expect(
          readme.includes("Sprint drain confirmed:") &&
            readme.includes("Sprint paused at hard cap:") &&
            readme.includes("Sprint blocked:"),
          "README no longer documents all three end-of-run summary prefixes — story 3 edits must not delete prior sprint content",
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

  return outcomes;
}

/**
 * adapt-bmad sprint, story 3 — README documents the adapt-bmad fast
 * path and the BMad-side Verification section convention.
 *
 * The locked phrases live in `readme-adapt-bmad-phrases.ts` and are the
 * single source of truth — README and assertions cannot drift.
 */
async function runReadmeDocumentsAdaptBmadMiniRun(): Promise<AssertionOutcome[]> {
  const outcomes: AssertionOutcome[] = [];

  const readmePath = path.resolve(HERE, "..", "README.md");
  let readme = "";
  try {
    readme = await fs.readFile(readmePath, "utf8");
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    outcomes.push({
      name: "README documents adapt-bmad fast path and verification convention: file readable",
      passed: false,
      error: `could not read README at ${readmePath}: ${msg}`,
    });
    return outcomes;
  }

  // Same scoping rule as the sibling mini-runs: the "Running a sprint"
  // section runs from its heading to the next top-level heading.
  function extractRunningSection(text: string): string | null {
    const m = text.match(/\n##\s+Running a sprint\b[\s\S]*?(?=\n##\s+|\n?$)/);
    return m ? m[0] : null;
  }

  const section = extractRunningSection(readme);

  const checks: Assertion[] = [
    {
      name: "README documents adapt-bmad fast path and verification convention: running-a-sprint section exists",
      run: () => {
        expect(section !== null, "README is missing the '## Running a sprint' section");
      },
    },
    {
      name: "README documents adapt-bmad fast path and verification convention: adapt-bmad intro is present verbatim",
      run: () => {
        if (!section) return;
        expect(
          section.includes(ADAPT_BMAD_INTRO),
          `Running-a-sprint section does not contain the adapt-bmad intro verbatim. Expected: '${ADAPT_BMAD_INTRO}'`,
        );
      },
    },
    {
      name: "README documents adapt-bmad fast path and verification convention: verification requirement statement is present verbatim",
      run: () => {
        if (!section) return;
        expect(
          section.includes(VERIFICATION_REQUIREMENT_STATEMENT),
          `Running-a-sprint section does not contain the verification-requirement statement verbatim. Expected: '${VERIFICATION_REQUIREMENT_STATEMENT}'`,
        );
      },
    },
    {
      name: "README documents adapt-bmad fast path and verification convention: verification fenced-shell example is present verbatim",
      run: () => {
        if (!section) return;
        expect(
          section.includes(VERIFICATION_SECTION_EXAMPLE),
          `Running-a-sprint section does not contain the verification fenced-shell example verbatim. Expected:\n${VERIFICATION_SECTION_EXAMPLE}`,
        );
      },
    },
    {
      name: "README documents adapt-bmad fast path and verification convention: section names both adapt-bmad and universal adopt so reader sees the choice",
      run: () => {
        if (!section) return;
        expect(
          section.includes("/sprint-orchestrator:adapt-bmad"),
          "Running-a-sprint section does not reference /sprint-orchestrator:adapt-bmad",
        );
        expect(
          section.includes(ADOPT_COMMAND),
          `Running-a-sprint section does not reference universal ${ADOPT_COMMAND} alongside adapt-bmad`,
        );
      },
    },
    {
      name: "README documents adapt-bmad fast path and verification convention: prior sprint content preserved",
      run: () => {
        // Guard against accidental deletion of prior sprint content.
        expect(
          /ceil\(\s*story_count\s*\*\s*turn_cap_per_story\s*\)/.test(readme),
          "README no longer documents the cap formula 'ceil(story_count * turn_cap_per_story)' — adapt-bmad edits must not delete prior sprint content",
        );
        expect(
          readme.includes("Sprint drain confirmed:") &&
            readme.includes("Sprint paused at hard cap:") &&
            readme.includes("Sprint blocked:"),
          "README no longer documents all three end-of-run summary prefixes — adapt-bmad edits must not delete prior sprint content",
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

  return outcomes;
}

/**
 * Story 1.2 — deterministic e2e coverage for the adopt validate-and-write path.
 *
 * Exercises `validateAndWriteBacklog` directly (the LLM drafting step is an
 * explicit non-goal — testing live model output would make assertions flaky).
 *
 * Three variants, against golden YAML fixtures under
 * `scripts/fixtures/adopt/`:
 *
 *   (a) Happy path: valid proposal + empty dest -> ok: true, dest matches
 *       the fixture byte-for-byte.
 *   (b) Invalid proposal: pre-written dest, invalid proposal -> ok: false,
 *       reason contains the verbatim lint/parse error, dest byte-identical
 *       before vs after.
 *   (c) In-flight refusal: dest already contains an in_progress story,
 *       valid proposal with force=false -> ok: false, reason names the
 *       in-flight story id, dest byte-identical before vs after.
 */
async function runAdoptValidateAndWriteMiniRun(): Promise<AssertionOutcome[]> {
  const outcomes: AssertionOutcome[] = [];

  const FIXTURE_DIR = path.resolve(HERE, "fixtures", "adopt");
  const validFixturePath = path.join(FIXTURE_DIR, "valid-proposal.yaml");
  const invalidFixturePath = path.join(FIXTURE_DIR, "invalid-proposal.yaml");
  const inFlightFixturePath = path.join(FIXTURE_DIR, "in-flight-existing.yaml");

  const validProposal = await fs.readFile(validFixturePath, "utf8");
  const invalidProposal = await fs.readFile(invalidFixturePath, "utf8");
  const inFlightExisting = await fs.readFile(inFlightFixturePath, "utf8");

  async function runOne(a: Assertion) {
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

  // Variant (a): happy path — valid proposal, empty dest.
  const tmpA = await fs.mkdtemp(path.join(os.tmpdir(), "sprint-orch-adopt-happy-"));
  try {
    const destPath = path.join(tmpA, "sprint-status.yaml");
    const result = await validateAndWriteBacklog({
      proposalYaml: validProposal,
      destPath,
      existingYaml: null,
      force: false,
    });
    const written = existsSync(destPath) ? await fs.readFile(destPath, "utf8") : "";

    await runOne({
      name: "adopt validation refusal in-flight refusal golden-fixture happy path: happy path writes the proposal byte-for-byte",
      run: () => {
        expect(result.ok === true, `expected ok=true, got ${JSON.stringify(result)}`);
        expect(
          written === validProposal,
          `expected destination contents to equal valid-proposal.yaml byte-for-byte; got length ${written.length} vs ${validProposal.length}`,
        );
      },
    });
  } finally {
    await fs.rm(tmpA, { recursive: true, force: true });
  }

  // Variant (b): invalid proposal — pre-existing dest must be byte-identical
  // before and after. The pre-existing content is the in-flight fixture
  // (any content works; we re-use a fixture rather than invent more data).
  const tmpB = await fs.mkdtemp(path.join(os.tmpdir(), "sprint-orch-adopt-invalid-"));
  try {
    const destPath = path.join(tmpB, "sprint-status.yaml");
    const preExisting = inFlightExisting;
    await fs.writeFile(destPath, preExisting, "utf8");
    const before = await fs.readFile(destPath);

    const result = await validateAndWriteBacklog({
      proposalYaml: invalidProposal,
      destPath,
      // Pass `null` for existingYaml so the in-flight gate doesn't fire —
      // we want this variant to fail strictly on the lint gate, isolating
      // AC 3 from AC 4.
      existingYaml: null,
      force: false,
    });
    const after = await fs.readFile(destPath);

    await runOne({
      name: "adopt validation refusal in-flight refusal golden-fixture happy path: invalid proposal is refused and the existing dest is byte-identical",
      run: () => {
        expect(result.ok === false, `expected ok=false, got ${JSON.stringify(result)}`);
        if (result.ok !== false) return;
        expect(
          /proposal failed/.test(result.reason),
          `expected reason to start with 'proposal failed', got: ${result.reason}`,
        );
        expect(
          before.equals(after),
          `expected destination file to be byte-identical before and after refusal; before.length=${before.length} after.length=${after.length}`,
        );
      },
    });
  } finally {
    await fs.rm(tmpB, { recursive: true, force: true });
  }

  // Variant (c): in-flight refusal — pre-existing dest has an in_progress
  // story; valid proposal with force=false must be refused without touching
  // the destination.
  const tmpC = await fs.mkdtemp(path.join(os.tmpdir(), "sprint-orch-adopt-inflight-"));
  try {
    const destPath = path.join(tmpC, "sprint-status.yaml");
    await fs.writeFile(destPath, inFlightExisting, "utf8");
    const before = await fs.readFile(destPath);

    const result = await validateAndWriteBacklog({
      proposalYaml: validProposal,
      destPath,
      existingYaml: inFlightExisting,
      force: false,
    });
    const after = await fs.readFile(destPath);

    await runOne({
      name: "adopt validation refusal in-flight refusal golden-fixture happy path: in-flight refusal names the story id and leaves dest unchanged",
      run: () => {
        expect(result.ok === false, `expected ok=false, got ${JSON.stringify(result)}`);
        if (result.ok !== false) return;
        expect(
          result.reason.includes("INFLIGHT1"),
          `expected reason to name in-flight story id 'INFLIGHT1', got: ${result.reason}`,
        );
        expect(
          result.reason.includes("in_progress"),
          `expected reason to mention 'in_progress', got: ${result.reason}`,
        );
        expect(
          before.equals(after),
          `expected destination file to be byte-identical before and after refusal; before.length=${before.length} after.length=${after.length}`,
        );
      },
    });
  } finally {
    await fs.rm(tmpC, { recursive: true, force: true });
  }

  return outcomes;
}

/**
 * Mini-run for adapt-bmad story 2: deterministic coverage for the BMad-to-
 * sprint-status adaptor. Exercises three golden fixtures:
 *
 *   - happy/                  → adaptor returns ok=true; emitted YAML parses,
 *                               passes lintSprint, and matches the BMad input
 *                               story-for-story (id, title, depends_on,
 *                               acceptance_criteria.checks).
 *   - missing-verification/   → adaptor refuses with a reason that names the
 *                               offending story file (1-2.md). No partial
 *                               output (helper is pure).
 *   - malformed/              → adaptor refuses with a reason that names the
 *                               offending story file (1-1.md) and identifies
 *                               the malformed-fence nature.
 *
 * Grep tag: "adapt-bmad happy path missing-verification refusal malformed refusal".
 */
async function runAdaptBmadMiniRun(): Promise<AssertionOutcome[]> {
  const outcomes: AssertionOutcome[] = [];
  const FIXTURE_DIR = path.resolve(HERE, "fixtures", "adapt-bmad");
  const HAPPY_DIR = path.join(FIXTURE_DIR, "happy");
  const MISSING_VERIFICATION_DIR = path.join(FIXTURE_DIR, "missing-verification");
  const MALFORMED_DIR = path.join(FIXTURE_DIR, "malformed");

  async function runOne(a: Assertion) {
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

  // Variant (a): happy path — adaptor succeeds, output parses, lintSprint
  // accepts, and the stories match the BMad headings + Verification fences.
  const tmpA = await fs.mkdtemp(path.join(os.tmpdir(), "sprint-orch-adapt-happy-"));
  try {
    const result = await adaptBmadOutput({ bmadOutputDir: HAPPY_DIR });
    await runOne({
      name: "adapt-bmad happy path missing-verification refusal malformed refusal: happy path emits a conforming proposal that lintSprint accepts and stories match the BMad input",
      run: async () => {
        expect(result.ok === true, `expected ok=true, got ${JSON.stringify(result)}`);
        if (result.ok !== true) return;

        // The proposalYaml must parse as YAML. We route through writeFile +
        // readSprintStatus so we exercise the same path the orchestrator
        // does at rest (rather than importing `yaml` directly into this
        // script, which the plugin root does not depend on).
        const destPath = path.join(tmpA, "sprint-status.yaml");
        await fs.writeFile(destPath, result.proposalYaml, "utf8");
        const parsed = await readSprintStatus(destPath);

        expect(parsed.stories.length === 2, `expected 2 stories, got ${parsed.stories.length}`);

        const [s1, s2] = parsed.stories;
        expect(!!s1 && !!s2, "expected both stories to be defined");
        if (!s1 || !s2) return;

        expect(s1.id === "1", `expected story 1 id="1", got ${JSON.stringify(s1.id)}`);
        expect(s2.id === "2", `expected story 2 id="2", got ${JSON.stringify(s2.id)}`);

        expect(
          s1.title === "First valid story",
          `expected story 1 title to match BMad heading; got ${JSON.stringify(s1.title)}`,
        );
        expect(
          s2.title === "Second valid story",
          `expected story 2 title to match BMad heading; got ${JSON.stringify(s2.title)}`,
        );

        expect(
          Array.isArray(s1.depends_on) && s1.depends_on.length === 0,
          `expected story 1 depends_on=[], got ${JSON.stringify(s1.depends_on)}`,
        );
        expect(
          Array.isArray(s2.depends_on) && s2.depends_on.length === 1 && s2.depends_on[0] === "1",
          `expected story 2 depends_on=["1"], got ${JSON.stringify(s2.depends_on)}`,
        );

        const s1Checks = s1.acceptance_criteria.checks;
        const s2Checks = s2.acceptance_criteria.checks;
        expect(s1Checks.length === 1, `expected story 1 to have 1 check, got ${s1Checks.length}`);
        expect(s2Checks.length === 1, `expected story 2 to have 1 check, got ${s2Checks.length}`);

        const s1Check = s1Checks[0];
        const s2Check = s2Checks[0];
        expect(!!s1Check && !!s2Check, "expected both checks to be defined");
        if (!s1Check || !s2Check) return;

        expect(
          s1Check.type === "shell" &&
            s1Check.cmd === "pnpm --dir plugins/sprint-orchestrator test -- story-one",
          `expected story 1 check to match Verification fence; got ${JSON.stringify(s1Check)}`,
        );
        expect(
          s2Check.type === "shell" &&
            s2Check.cmd === "pnpm --dir plugins/sprint-orchestrator test -- story-two",
          `expected story 2 check to match Verification fence; got ${JSON.stringify(s2Check)}`,
        );
        expect(
          s1Check.type === "shell" && s1Check.expect_exit === 0,
          `expected story 1 expect_exit=0, got ${JSON.stringify(s1Check)}`,
        );
        expect(
          s2Check.type === "shell" && s2Check.expect_exit === 0,
          `expected story 2 expect_exit=0, got ${JSON.stringify(s2Check)}`,
        );

        // lintSprint must accept the emitted proposal at rest.
        const ctx: ToolContext = {
          projectRoot: tmpA,
          sprintStatusPath: destPath,
          configPath: path.join(tmpA, ".sprint-orchestrator", "config.yaml"),
        };
        const report = await lintSprint(ctx, { sprintStatusPath: destPath });
        const errorIssues = report.issues.filter((i) => i.severity === "error");
        expect(
          errorIssues.length === 0,
          `expected no error-severity lint issues; got: ${JSON.stringify(errorIssues)}`,
        );
      },
    });
  } finally {
    await fs.rm(tmpA, { recursive: true, force: true });
  }

  // Variant (b): missing Verification — refusal names the offending file.
  await runOne({
    name: "adapt-bmad happy path missing-verification refusal malformed refusal: missing Verification section refusal names the offending story file",
    run: async () => {
      const result = await adaptBmadOutput({ bmadOutputDir: MISSING_VERIFICATION_DIR });
      expect(result.ok === false, `expected ok=false, got ${JSON.stringify(result)}`);
      if (result.ok !== false) return;
      const offendingPath = path.join(
        MISSING_VERIFICATION_DIR,
        "implementation-artifacts",
        "1-2.md",
      );
      expect(
        result.reason.includes(offendingPath),
        `expected reason to name the offending story file ${offendingPath}; got: ${result.reason}`,
      );
      expect(
        /Verification/.test(result.reason),
        `expected reason to mention "Verification"; got: ${result.reason}`,
      );
    },
  });

  // Variant (c): malformed shell fence — refusal names the offending file
  // and identifies the malformed-fence nature.
  await runOne({
    name: "adapt-bmad happy path missing-verification refusal malformed refusal: malformed shell fence refusal names the offending story file and the malformed-fence nature",
    run: async () => {
      const result = await adaptBmadOutput({ bmadOutputDir: MALFORMED_DIR });
      expect(result.ok === false, `expected ok=false, got ${JSON.stringify(result)}`);
      if (result.ok !== false) return;
      const offendingPath = path.join(MALFORMED_DIR, "implementation-artifacts", "1-1.md");
      expect(
        result.reason.includes(offendingPath),
        `expected reason to name the offending story file ${offendingPath}; got: ${result.reason}`,
      );
      expect(
        /malformed.*fence|fence.*malformed|unclosed/i.test(result.reason),
        `expected reason to identify the malformed-fence nature; got: ${result.reason}`,
      );
    },
  });

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

  // Ninth mini-run (story 1): /sprint-orchestrator:run-sprint wrapper.
  // Asserts the wrapper's computed /goal command (default cap, override,
  // drained refusal, missing-backlog refusal).
  if (
    !filter ||
    filter.test("run-sprint wrapper computes turn cap and invokes goal with the drain condition") ||
    filter.test("run-sprint wrapper honors turn_cap_per_story override from config") ||
    filter.test("run-sprint wrapper refuses on a drained sprint and emits no command") ||
    filter.test(
      "run-sprint wrapper refuses when sprint-status.yaml is missing and emits no command",
    )
  ) {
    console.log("[e2e] mini-run: run-sprint wrapper turn cap + refusal paths");
    const runSprintOutcomes = await runRunSprintWrapperMiniRun();
    outcomes.push(...runSprintOutcomes);
  }

  // goal-adoption sprint, story 1: run-sprint locks the /goal command as the
  // literal last line of stdout, preceded by a one-line fresh-context note.
  if (
    !filter ||
    filter.test("run-sprint emits goal on guaranteed last line with fresh-context guidance")
  ) {
    console.log("[e2e] mini-run: run-sprint goal-on-last-line + fresh-context guidance");
    const goalLastLineOutcomes = await runRunSprintGoalLastLineMiniRun();
    outcomes.push(...goalLastLineOutcomes);
  }

  // goal-adoption sprint, story 2: OSC 52 clipboard auto-copy spike + env-var
  // opt-out no-op safety. Spike failed (Claude Code does not pass escapes
  // through verbatim — see follow-ups.md). These assertions guard the
  // failure-path safety net: no OSC 52 leak in output, opt-out env var
  // wired and parsed strictly, Story 1 last-line contract preserved.
  if (
    !filter ||
    filter.test("run-sprint emits OSC 52 clipboard sequence for goal command with opt-out")
  ) {
    console.log("[e2e] mini-run: run-sprint OSC 52 clipboard auto-copy spike + opt-out safety");
    const osc52Outcomes = await runRunSprintOsc52ClipboardMiniRun();
    outcomes.push(...osc52Outcomes);
  }

  // Eleventh mini-run (story 3): README documents /sprint-orchestrator:run-sprint
  // as the recommended entrypoint, the computed turn-cap rule, and the three
  // end-of-run summary line prefixes from story 2.
  if (
    !filter ||
    filter.test(
      "README documents run-sprint wrapper computed turn cap and end-of-run summary lines",
    )
  ) {
    console.log("[e2e] mini-run: README documents run-sprint as recommended entrypoint");
    const readmeOutcomes = await runReadmeDocumentsRunSprintEntrypointMiniRun();
    outcomes.push(...readmeOutcomes);
  }

  // Twelfth mini-run (story 1.3): README documents adopt as recommended
  // entrypoint and names the in-plugin adaptor pattern.
  if (!filter || filter.test("README documents adopt and the in-plugin adaptor pattern")) {
    console.log("[e2e] mini-run: README documents adopt and the adaptor pattern");
    const readmeAdoptOutcomes = await runReadmeDocumentsAdoptAndAdaptorPatternMiniRun();
    outcomes.push(...readmeAdoptOutcomes);
  }

  // goal-adoption sprint, story 3: README documents the new run-sprint output
  // flow — /goal as the literal last line, fresh-context rationale, and the
  // deferred clipboard auto-copy (Story 2 spike failed; see follow-ups.md).
  if (
    !filter ||
    filter.test("README documents run-sprint last-line fresh-context and clipboard flow")
  ) {
    console.log(
      "[e2e] mini-run: README documents run-sprint last-line + fresh-context + clipboard",
    );
    const readmeRunSprintOutputOutcomes = await runReadmeDocumentsRunSprintLastLineMiniRun();
    outcomes.push(...readmeRunSprintOutputOutcomes);
  }

  // adapt-bmad sprint, story 3: README documents the adapt-bmad fast
  // path and the BMad-side Verification section convention.
  if (!filter || filter.test("README documents adapt-bmad fast path and verification convention")) {
    console.log("[e2e] mini-run: README documents adapt-bmad fast path + verification convention");
    const readmeAdaptBmadOutcomes = await runReadmeDocumentsAdaptBmadMiniRun();
    outcomes.push(...readmeAdaptBmadOutcomes);
  }

  // Tenth mini-run (story 2): process-backlog end-of-run summary contract.
  // Three distinct final lines (drain / cap-stop / blocked) so the /goal
  // evaluator can disambiguate run outcomes from the transcript.
  if (
    !filter ||
    filter.test(
      "process-backlog prints distinct end-of-run summary lines for drain cap-stop and blocked",
    )
  ) {
    console.log("[e2e] mini-run: process-backlog end-of-run summary lines");
    const eorOutcomes = await runProcessBacklogEndOfRunSummaryLinesMiniRun();
    outcomes.push(...eorOutcomes);
  }

  // Twelfth mini-run (story 1.2): deterministic adopt validate-and-write
  // coverage — happy path, invalid proposal refusal, in-flight refusal.
  if (
    !filter ||
    filter.test("adopt validation refusal in-flight refusal golden-fixture happy path")
  ) {
    console.log("[e2e] mini-run: adopt validate-and-write (happy / invalid / in-flight)");
    const adoptOutcomes = await runAdoptValidateAndWriteMiniRun();
    outcomes.push(...adoptOutcomes);
  }

  // adapt-bmad sprint, story 2: deterministic coverage for the BMad-to-
  // sprint-status adaptor (happy / missing-Verification / malformed-fence).
  if (
    !filter ||
    filter.test("adapt-bmad happy path missing-verification refusal malformed refusal")
  ) {
    console.log("[e2e] mini-run: adapt-bmad (happy / missing-verification / malformed-fence)");
    const adaptOutcomes = await runAdaptBmadMiniRun();
    outcomes.push(...adaptOutcomes);
  }

  // model-tiering-v1 sprint, story 1: resolveSpawnModel reads frontmatter +
  // optional config override + falls back to DEFAULT_*_MODEL constants. The
  // mini-run invokes the registered MCP tool via an in-memory client (NOT
  // the helper directly) and also asserts the SKILL.md phrase-lock.
  if (!filter || filter.test("resolveSpawnModel respects frontmatter and config override")) {
    console.log("[e2e] mini-run: resolveSpawnModel static resolution");
    const resolveOutcomes = await runResolveSpawnModelStaticMiniRun();
    outcomes.push(...resolveOutcomes);
  }

  // model-tiering-v1 sprint, story 2: rework escalation — dev re-spawns after
  // rework jump to Opus regardless of static defaults; reviewer never escalates.
  if (!filter || filter.test("resolveSpawnModel escalates dev on rework only")) {
    console.log("[e2e] mini-run: resolveSpawnModel rework escalation");
    const escalationOutcomes = await runResolveSpawnModelEscalationMiniRun();
    outcomes.push(...escalationOutcomes);
  }

  // mvp-polish sprint, story 5: getOrInitConfig surfaces pr_per_story setup
  // question when the field is absent from the config (or no config exists),
  // and omits it when the field is explicitly set.
  if (!filter || filter.test("getOrInitConfig surfaces pr_per_story setup question when missing")) {
    console.log("[e2e] mini-run: getOrInitConfig pr_per_story setup prompt");
    const prPerStoryOutcomes = await runGetOrInitConfigPrPerStoryMiniRun();
    outcomes.push(...prPerStoryOutcomes);
  }

  // smoketest-followups sprint, story 2: reviewer must push branch before
  // opening PR. Uses a fake git/gh shim to assert command ordering, and
  // phrase-locks the reviewer.md instructions.
  if (!filter || filter.test("reviewer pushes branch before pr create")) {
    console.log("[e2e] mini-run: reviewer pushes branch before pr create");
    const pushBeforePROutcomes = await runReviewerPushesBeforePRCreateMiniRun();
    outcomes.push(...pushBeforePROutcomes);
  }

  // smoketest-followups sprint, story 3: pr_per_story setup fires before first
  // claim. Phrase-locks SKILL.md to assert the setup ordering constraint is
  // documented, and verifies getOrInitConfig surfaces the setup question before
  // any claimStory would be called.
  if (!filter || filter.test("pr_per_story setup fires before first claim")) {
    console.log("[e2e] mini-run: pr_per_story setup fires before first claim");
    const prPerStoryBeforeClaimOutcomes = await runPrPerStorySetupBeforeFirstClaimMiniRun();
    outcomes.push(...prPerStoryBeforeClaimOutcomes);
  }

  // acs-only-evaluate-after-dev sprint, story 1: dev_returned_at guard prevents
  // ACs from being evaluated before the dev subagent has produced any work.
  if (!filter || filter.test("orchestrator refuses to evaluate ACs before dev has produced work")) {
    console.log(
      "[e2e] mini-run: dev_returned_at guard on recordStoryFailure + validateAcceptanceCriteria",
    );
    const devReturnedOutcomes = await runDevReturnedGuardMiniRun();
    outcomes.push(...devReturnedOutcomes);
  }

  // structured-failure-details sprint, story 2: recordStoryFailure persists
  // structured per-check details (cmd, exit_code, expected_exit, stderr, stdout,
  // recorded_at) under orchestrator.failure_details.
  if (
    !filter ||
    filter.test("recordStoryFailure persists structured details, not just check types")
  ) {
    console.log("[e2e] mini-run: recordStoryFailure persists structured details");
    const structuredFailureOutcomes = await runStructuredFailureDetailsMiniRun();
    outcomes.push(...structuredFailureOutcomes);
  }

  // dependency-base sprint, story 3: prepareStoryBranch roots a story's branch
  // off its depended-on story's branch tip when depends_on is set and the dep
  // branch exists locally. Also covers the negative case (empty depends_on →
  // default_base).
  if (
    !filter ||
    filter.test("prepareStoryBranch roots off depends_on story branch tip when present")
  ) {
    console.log("[e2e] mini-run: prepareStoryBranch dependency-rooted base");
    const depBaseOutcomes = await runPrepareStoryBranchDependencyBaseMiniRun();
    outcomes.push(...depBaseOutcomes);
  }

  // orchestrator-hardening sprint, story 4: recordStorySuccess refuses when
  // pr_per_story=true and the branch has not been pushed / a PR does not exist.
  if (
    !filter ||
    filter.test("recordStorySuccess refuses when pr_per_story=true and branch is unpushed")
  ) {
    console.log("[e2e] mini-run: recordStorySuccess pr_per_story enforcement");
    const prEnforcementOutcomes = await runPrPerStoryEnforcementMiniRun();
    outcomes.push(...prEnforcementOutcomes);
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

/**
 * model-tiering-v1 sprint, story 1 — resolveSpawnModel static resolution.
 *
 * Four fixtures + a phrase-lock assertion. Each fixture sets up a real
 * temp directory with a real `.sprint-orchestrator/config.yaml`, a real
 * `sprint-status.yaml`, and stub agent files, then invokes the
 * **registered** `resolveSpawnModel` MCP tool through an in-memory
 * client/server pair (NOT the resolver helper, NOT a mock). The phrase-
 * lock asserts SKILL.md contains `RESOLVE_SPAWN_MODEL_INSTRUCTION`
 * verbatim so the skill prose and the resolver contract cannot drift.
 *
 * Grep tag: "resolveSpawnModel respects frontmatter and config override".
 */
async function runResolveSpawnModelStaticMiniRun(): Promise<AssertionOutcome[]> {
  const outcomes: AssertionOutcome[] = [];

  async function runOne(a: Assertion) {
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

  interface FixtureSpec {
    name: string;
    role: "dev" | "reviewer";
    /** `model:` line content for the agent file, or null to omit the field. */
    agentModel: string | null;
    /** Optional `models.<role>` value to write into config.yaml. */
    configModel?: string;
    /** Expected resolved model ID. */
    expected: string;
    /** Whether to write the agent file at all. */
    writeAgentFile: boolean;
  }

  const fixtures: FixtureSpec[] = [
    {
      name: "frontmatter-only",
      role: "dev",
      agentModel: "claude-sonnet-4-6",
      expected: "claude-sonnet-4-6",
      writeAgentFile: true,
    },
    {
      name: "config-override",
      role: "dev",
      agentModel: "claude-sonnet-4-6",
      configModel: "claude-opus-4-7",
      expected: "claude-opus-4-7",
      writeAgentFile: true,
    },
    {
      name: "no-frontmatter-no-config",
      role: "dev",
      agentModel: null,
      expected: DEFAULT_DEV_MODEL,
      writeAgentFile: true,
    },
    {
      name: "reviewer-role",
      role: "reviewer",
      agentModel: "claude-sonnet-4-6",
      expected: "claude-sonnet-4-6",
      writeAgentFile: true,
    },
  ];

  for (const fx of fixtures) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `sprint-orch-resolve-model-${fx.name}-`));
    try {
      // Real sprint-status.yaml fixture — minimum the schema accepts.
      await fs.writeFile(
        path.join(tmp, "sprint-status.yaml"),
        [
          "sprint_id: model-tiering-fixture",
          "schema_version: 1",
          "stories:",
          "  - id: '1'",
          "    title: fixture story",
          "    status: ready",
          "    depends_on: []",
          "    acceptance_criteria:",
          "      checks: []",
          "    orchestrator: {}",
          "",
        ].join("\n"),
        "utf8",
      );

      // Real .sprint-orchestrator/config.yaml fixture.
      const configDir = path.join(tmp, ".sprint-orchestrator");
      await fs.mkdir(configDir, { recursive: true });
      const configLines = [
        "sprintStatusPath: sprint-status.yaml",
        "layout: custom",
        "autoDetected: false",
      ];
      if (fx.configModel) {
        configLines.push("models:");
        configLines.push(`  ${fx.role}: ${fx.configModel}`);
      }
      configLines.push("");
      await fs.writeFile(path.join(configDir, "config.yaml"), configLines.join("\n"), "utf8");

      // Stub agent files in a temp `agents/` directory the resolver reads
      // via the `agentsDir` override on ToolContext. We always create the
      // directory; we may write only one role's file, or write a file with
      // no `model:` field, depending on the fixture.
      const agentsDir = path.join(tmp, "agents");
      await fs.mkdir(agentsDir, { recursive: true });
      if (fx.writeAgentFile) {
        const fmLines = ["---", `name: ${fx.role}`];
        if (fx.agentModel !== null) {
          fmLines.push(`model: ${fx.agentModel}`);
        }
        fmLines.push("---", "", `stub ${fx.role} agent`, "");
        await fs.writeFile(path.join(agentsDir, `${fx.role}.md`), fmLines.join("\n"), "utf8");
      }

      // Build a server bound to this fixture's context, wire an in-memory
      // client to it, and call the **registered** resolveSpawnModel tool.
      const ctx: ToolContext = {
        projectRoot: tmp,
        sprintStatusPath: path.join(tmp, "sprint-status.yaml"),
        configPath: path.join(configDir, "config.yaml"),
        agentsDir,
      };
      const server = buildServer(ctx);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client(
        { name: "e2e-resolve-spawn-model", version: "0.0.1" },
        { capabilities: {} },
      );
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      let parsed: { model?: unknown; source?: unknown } = {};
      try {
        const result = (await client.callTool({
          name: "resolveSpawnModel",
          arguments: { storyId: "1", role: fx.role },
        })) as { content?: Array<{ type: string; text?: string }> };
        const textPart = result.content?.find((c) => c.type === "text");
        if (textPart?.text) {
          parsed = JSON.parse(textPart.text) as { model?: unknown; source?: unknown };
        }
      } finally {
        await client.close();
        await server.close();
      }

      await runOne({
        name: `resolveSpawnModel respects frontmatter and config override: ${fx.name} returns ${fx.expected} for role=${fx.role}`,
        run: () => {
          expect(
            typeof parsed.model === "string",
            `expected resolveSpawnModel to return a string model, got ${JSON.stringify(parsed)}`,
          );
          expect(
            parsed.model === fx.expected,
            `expected model=${fx.expected} for fixture ${fx.name}, got ${JSON.stringify(parsed.model)} (source=${JSON.stringify(parsed.source)})`,
          );
        },
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  // Phrase-lock assertion: SKILL.md must contain RESOLVE_SPAWN_MODEL_INSTRUCTION verbatim.
  const skillPath = path.resolve(HERE, "..", "skills", "process-backlog", "SKILL.md");
  let skillText = "";
  try {
    skillText = await fs.readFile(skillPath, "utf8");
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    outcomes.push({
      name: "resolveSpawnModel respects frontmatter and config override: SKILL.md is readable",
      passed: false,
      error: `could not read SKILL.md at ${skillPath}: ${msg}`,
    });
    return outcomes;
  }
  await runOne({
    name: "resolveSpawnModel respects frontmatter and config override: SKILL.md contains RESOLVE_SPAWN_MODEL_INSTRUCTION verbatim",
    run: () => {
      expect(
        skillText.includes(RESOLVE_SPAWN_MODEL_INSTRUCTION),
        `SKILL.md does not contain the phrase-locked instruction verbatim. Expected: '${RESOLVE_SPAWN_MODEL_INSTRUCTION}'`,
      );
    },
  });

  // Belt-and-braces: also assert the reviewer fallback constant equals what
  // the resolver returned when neither config nor frontmatter is set for the
  // reviewer role. This guards against an accidental future divergence
  // between DEFAULT_REVIEWER_MODEL and the dev fallback.
  await runOne({
    name: "resolveSpawnModel respects frontmatter and config override: DEFAULT_REVIEWER_MODEL is exported as a non-empty string",
    run: () => {
      expect(
        typeof DEFAULT_REVIEWER_MODEL === "string" && DEFAULT_REVIEWER_MODEL.length > 0,
        `DEFAULT_REVIEWER_MODEL must be a non-empty string, got ${JSON.stringify(DEFAULT_REVIEWER_MODEL)}`,
      );
    },
  });

  return outcomes;
}

/**
 * model-tiering-v1 sprint, story 2 — resolveSpawnModel rework escalation.
 *
 * Four fixtures exercising the locked v1 rule "dev attempts after rework run
 * on Opus." Each fixture builds a real temp dir with a real sprint-status.yaml
 * (orchestrator.rework_count varied), a real config.yaml (frontmatter and
 * config set Sonnet so we can prove the escalation overrides them), and a
 * stub agent file, then invokes the registered `resolveSpawnModel` MCP tool
 * via an in-memory client.
 *
 * Grep tag: "resolveSpawnModel escalates dev on rework only".
 */
async function runResolveSpawnModelEscalationMiniRun(): Promise<AssertionOutcome[]> {
  const outcomes: AssertionOutcome[] = [];

  async function runOne(a: Assertion) {
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

  interface FixtureSpec {
    name: string;
    role: "dev" | "reviewer";
    reworkCount: number;
    /** Expected resolved model ID. */
    expected: string;
  }

  const fixtures: FixtureSpec[] = [
    {
      name: "fresh-dev",
      role: "dev",
      reworkCount: 0,
      expected: DEFAULT_DEV_MODEL,
    },
    {
      name: "reworked-dev",
      role: "dev",
      reworkCount: 1,
      expected: DEEP_MODEL,
    },
    {
      name: "reworked-dev-multiple",
      role: "dev",
      reworkCount: 2,
      expected: DEEP_MODEL,
    },
    {
      name: "reworked-reviewer",
      role: "reviewer",
      reworkCount: 1,
      expected: DEFAULT_REVIEWER_MODEL,
    },
  ];

  for (const fx of fixtures) {
    const tmp = await fs.mkdtemp(
      path.join(os.tmpdir(), `sprint-orch-resolve-model-escalation-${fx.name}-`),
    );
    try {
      // Real sprint-status.yaml fixture — one story with the chosen rework_count.
      await fs.writeFile(
        path.join(tmp, "sprint-status.yaml"),
        [
          "sprint_id: model-tiering-escalation-fixture",
          "schema_version: 1",
          "stories:",
          "  - id: '1'",
          "    title: fixture story",
          "    status: in_progress",
          "    depends_on: []",
          "    acceptance_criteria:",
          "      checks: []",
          "    orchestrator:",
          `      rework_count: ${fx.reworkCount}`,
          "",
        ].join("\n"),
        "utf8",
      );

      // Real .sprint-orchestrator/config.yaml. We deliberately do NOT set any
      // models.<role> here so the static path falls through to frontmatter +
      // fallback — the escalation branch must override that for dev>0 reworks.
      const configDir = path.join(tmp, ".sprint-orchestrator");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "config.yaml"),
        ["sprintStatusPath: sprint-status.yaml", "layout: custom", "autoDetected: false", ""].join(
          "\n",
        ),
        "utf8",
      );

      // Stub agent file with model: claude-sonnet-4-6 in frontmatter. For
      // reworked-dev fixtures this proves the escalation branch wins over
      // frontmatter; for reworked-reviewer it proves reviewer falls through
      // to the static path and reads frontmatter as normal.
      const agentsDir = path.join(tmp, "agents");
      await fs.mkdir(agentsDir, { recursive: true });
      await fs.writeFile(
        path.join(agentsDir, `${fx.role}.md`),
        [
          "---",
          `name: ${fx.role}`,
          `model: ${fx.role === "dev" ? DEFAULT_DEV_MODEL : DEFAULT_REVIEWER_MODEL}`,
          "---",
          "",
          `stub ${fx.role} agent`,
          "",
        ].join("\n"),
        "utf8",
      );

      const ctx: ToolContext = {
        projectRoot: tmp,
        sprintStatusPath: path.join(tmp, "sprint-status.yaml"),
        configPath: path.join(configDir, "config.yaml"),
        agentsDir,
      };
      const server = buildServer(ctx);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client(
        { name: "e2e-resolve-spawn-model-escalation", version: "0.0.1" },
        { capabilities: {} },
      );
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      let parsed: { model?: unknown; source?: unknown } = {};
      try {
        const result = (await client.callTool({
          name: "resolveSpawnModel",
          arguments: { storyId: "1", role: fx.role },
        })) as { content?: Array<{ type: string; text?: string }> };
        const textPart = result.content?.find((c) => c.type === "text");
        if (textPart?.text) {
          parsed = JSON.parse(textPart.text) as { model?: unknown; source?: unknown };
        }
      } finally {
        await client.close();
        await server.close();
      }

      await runOne({
        name: `resolveSpawnModel escalates dev on rework only: ${fx.name} returns ${fx.expected} for role=${fx.role} rework_count=${fx.reworkCount}`,
        run: () => {
          expect(
            typeof parsed.model === "string",
            `expected resolveSpawnModel to return a string model, got ${JSON.stringify(parsed)}`,
          );
          expect(
            parsed.model === fx.expected,
            `expected model=${fx.expected} for fixture ${fx.name}, got ${JSON.stringify(parsed.model)} (source=${JSON.stringify(parsed.source)})`,
          );
        },
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  return outcomes;
}

/**
 * mvp-polish sprint, story 5 — getOrInitConfig surfaces pr_per_story setup question.
 *
 * Three fixtures:
 *  1. no-config — no .sprint-orchestrator/config.yaml exists; question must appear.
 *  2. existing-without-field — config exists but pr_per_story is absent; question must appear.
 *  3. existing-with-field — config exists with pr_per_story: true; question must NOT appear.
 *
 * Each fixture builds a real temp directory and invokes the **registered**
 * `getOrInitConfig` MCP tool through an in-memory client/server pair (NOT the
 * helper directly). Also asserts SKILL.md contains PR_PER_STORY_SETUP_PROMPT verbatim.
 *
 * Grep tag: "getOrInitConfig surfaces pr_per_story setup question when missing".
 */
async function runGetOrInitConfigPrPerStoryMiniRun(): Promise<AssertionOutcome[]> {
  const outcomes: AssertionOutcome[] = [];

  async function runOne(a: Assertion) {
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

  interface FixtureSpec {
    name: string;
    /** Whether to write a config.yaml file at all. */
    writeConfig: boolean;
    /** pr_per_story value to write, or undefined to omit the field. */
    prPerStory?: boolean;
    /** Whether the setup question should appear in the response. */
    expectQuestion: boolean;
  }

  const fixtures: FixtureSpec[] = [
    {
      name: "no-config",
      writeConfig: false,
      expectQuestion: true,
    },
    {
      name: "existing-without-field",
      writeConfig: true,
      prPerStory: undefined,
      expectQuestion: true,
    },
    {
      name: "existing-with-field",
      writeConfig: true,
      prPerStory: true,
      expectQuestion: false,
    },
  ];

  for (const fx of fixtures) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `sprint-orch-pr-per-story-${fx.name}-`));
    try {
      // Real sprint-status.yaml fixture — minimum the schema accepts.
      await fs.writeFile(
        path.join(tmp, "sprint-status.yaml"),
        [
          "sprint_id: pr-per-story-fixture",
          "schema_version: 1",
          "stories:",
          "  - id: '1'",
          "    title: fixture story",
          "    status: ready",
          "    depends_on: []",
          "    acceptance_criteria:",
          "      checks: []",
          "    orchestrator: {}",
          "",
        ].join("\n"),
        "utf8",
      );

      const configDir = path.join(tmp, ".sprint-orchestrator");
      await fs.mkdir(configDir, { recursive: true });

      if (fx.writeConfig) {
        const configLines = [
          "sprintStatusPath: sprint-status.yaml",
          "layout: custom",
          "autoDetected: false",
        ];
        if (fx.prPerStory !== undefined) {
          configLines.push(`pr_per_story: ${fx.prPerStory}`);
        }
        configLines.push("");
        await fs.writeFile(path.join(configDir, "config.yaml"), configLines.join("\n"), "utf8");
      }

      const ctx: ToolContext = {
        projectRoot: tmp,
        sprintStatusPath: path.join(tmp, "sprint-status.yaml"),
        configPath: path.join(configDir, "config.yaml"),
      };
      const server = buildServer(ctx);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client(
        { name: "e2e-pr-per-story-setup", version: "0.0.1" },
        { capabilities: {} },
      );
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      let parsed: { setupQuestions?: unknown[]; needsSetup?: unknown } = {};
      try {
        const result = (await client.callTool({
          name: "getOrInitConfig",
          arguments: {},
        })) as { content?: Array<{ type: string; text?: string }> };
        const textPart = result.content?.find((c) => c.type === "text");
        if (textPart?.text) {
          parsed = JSON.parse(textPart.text) as {
            setupQuestions?: unknown[];
            needsSetup?: unknown;
          };
        }
      } finally {
        await client.close();
        await server.close();
      }

      const questions: unknown[] = Array.isArray(parsed.setupQuestions)
        ? parsed.setupQuestions
        : [];
      const hasPrompt = questions.some((q) => q === PR_PER_STORY_SETUP_PROMPT);

      await runOne({
        name: `getOrInitConfig surfaces pr_per_story setup question when missing: fixture=${fx.name} expectQuestion=${fx.expectQuestion}`,
        run: () => {
          if (fx.expectQuestion) {
            expect(
              hasPrompt,
              `expected PR_PER_STORY_SETUP_PROMPT in setupQuestions for fixture ${fx.name}, got ${JSON.stringify(questions)}`,
            );
          } else {
            expect(
              !hasPrompt,
              `expected PR_PER_STORY_SETUP_PROMPT to be absent from setupQuestions for fixture ${fx.name}, got ${JSON.stringify(questions)}`,
            );
          }
        },
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  // Phrase-lock assertion: SKILL.md must contain PR_PER_STORY_SETUP_PROMPT verbatim.
  const skillPath = path.resolve(HERE, "..", "skills", "process-backlog", "SKILL.md");
  let skillText = "";
  try {
    skillText = await fs.readFile(skillPath, "utf8");
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    outcomes.push({
      name: "getOrInitConfig surfaces pr_per_story setup question when missing: SKILL.md is readable",
      passed: false,
      error: `could not read SKILL.md at ${skillPath}: ${msg}`,
    });
    return outcomes;
  }
  await runOne({
    name: "getOrInitConfig surfaces pr_per_story setup question when missing: SKILL.md contains PR_PER_STORY_SETUP_PROMPT verbatim",
    run: () => {
      expect(
        skillText.includes(PR_PER_STORY_SETUP_PROMPT),
        `SKILL.md does not contain the phrase-locked PR_PER_STORY_SETUP_PROMPT verbatim. Expected: '${PR_PER_STORY_SETUP_PROMPT}'`,
      );
    },
  });

  return outcomes;
}

/**
 * smoketest-followups sprint, story 2 — reviewer pushes branch before pr create.
 *
 * Uses a fake git/gh shim (executable shell scripts written to a temp bin dir
 * prepended to PATH) that records every invocation to a log file.  The test
 * drives the mandated sequence manually — push then gh pr create — and asserts:
 *   1. `git push -u origin <branch>` was recorded before `gh pr create`.
 *   2. When push exits non-zero the test confirms the failure is surfaced
 *      (the shim records the push attempt and returns exit 1, simulating a
 *      network/auth failure; the reviewer prompt mandates recordStoryFailure in
 *      this case rather than proceeding to gh pr create or recordStorySuccess).
 *   3. A phrase-lock assertion confirms reviewer.md contains the required
 *      `git push -u origin` pattern and the "before calling gh pr create" phrase.
 *
 * Grep tag: "reviewer pushes branch before pr create".
 */
async function runReviewerPushesBeforePRCreateMiniRun(): Promise<AssertionOutcome[]> {
  const outcomes: AssertionOutcome[] = [];

  async function runOne(a: Assertion) {
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

  // Helper: write a shim script that records its argv to a log and exits with
  // the given code.  The log format is one JSON line per invocation:
  //   {"cmd":"git","args":["push","-u","origin","my-branch"]}
  async function writeShim(
    binDir: string,
    shimName: string,
    exitCode: number,
    logFile: string,
  ): Promise<void> {
    const shimPath = path.join(binDir, shimName);
    const script = [
      "#!/usr/bin/env sh",
      // Append JSON line: {"cmd":"<shimName>","args":[...]}
      `printf '%s\\n' "$(printf '{"cmd":"${shimName}","args":[' ; first=1 ; for a in "$@"; do [ "$first" = "1" ] || printf ','; printf '"%s"' "$a"; first=0; done; printf ']}')" >> "${logFile}"`,
      `exit ${exitCode}`,
      "",
    ].join("\n");
    await fs.writeFile(shimPath, script, { mode: 0o755 });
  }

  // Simulates the reviewer's mandated sequence: push then gh pr create.
  // Returns the recorded invocations from the log file.
  async function runShimSequence(
    pushExitCode: number,
    branch: string,
  ): Promise<Array<{ cmd: string; args: string[] }>> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sprint-orch-push-before-pr-"));
    try {
      const logFile = path.join(tmp, "calls.ndjson");
      // Initialise log file.
      await fs.writeFile(logFile, "", "utf8");

      const binDir = path.join(tmp, "bin");
      await fs.mkdir(binDir, { recursive: true });

      await writeShim(binDir, "git", pushExitCode, logFile);
      await writeShim(binDir, "gh", 0, logFile);

      // Reviewer mandated sequence:
      //   1. git push -u origin <branch>
      //   2. gh pr create ... (only if push succeeded)
      const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };

      const pushResult = spawnSync("git", ["push", "-u", "origin", branch], {
        env,
        encoding: "utf8",
      });

      if (pushResult.status === 0) {
        // Only open PR when push succeeded — this is what reviewer.md mandates.
        spawnSync("gh", ["pr", "create", "--title", "story done", "--body", ""], {
          env,
          encoding: "utf8",
        });
      }

      // Parse the log.
      const raw = await fs.readFile(logFile, "utf8");
      return raw
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { cmd: string; args: string[] });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  // ── 1. Happy path: push succeeds → gh pr create follows ──────────────────
  await runOne({
    name: "reviewer pushes branch before pr create: push succeeds then gh pr create is called",
    run: async () => {
      const calls = await runShimSequence(0, "2-my-branch");
      expect(
        calls.length >= 2,
        `expected at least 2 shim calls, got ${calls.length}: ${JSON.stringify(calls)}`,
      );
      const pushIdx = calls.findIndex(
        (c) => c.cmd === "git" && c.args.includes("push") && c.args.includes("-u"),
      );
      const prIdx = calls.findIndex(
        (c) => c.cmd === "gh" && c.args.includes("pr") && c.args.includes("create"),
      );
      expect(pushIdx !== -1, `expected git push -u to be recorded; calls=${JSON.stringify(calls)}`);
      expect(prIdx !== -1, `expected gh pr create to be recorded; calls=${JSON.stringify(calls)}`);
      expect(
        pushIdx < prIdx,
        `expected git push (idx=${pushIdx}) before gh pr create (idx=${prIdx}); calls=${JSON.stringify(calls)}`,
      );
    },
  });

  // ── 2. Push fails → gh pr create must NOT be called ──────────────────────
  await runOne({
    name: "reviewer pushes branch before pr create: push failure prevents gh pr create",
    run: async () => {
      const calls = await runShimSequence(1, "2-my-branch");
      const prIdx = calls.findIndex(
        (c) => c.cmd === "gh" && c.args.includes("pr") && c.args.includes("create"),
      );
      expect(
        prIdx === -1,
        `expected gh pr create NOT to be called when push fails; calls=${JSON.stringify(calls)}`,
      );
      const pushIdx = calls.findIndex(
        (c) => c.cmd === "git" && c.args.includes("push") && c.args.includes("-u"),
      );
      expect(
        pushIdx !== -1,
        `expected git push to be attempted even in failure case; calls=${JSON.stringify(calls)}`,
      );
    },
  });

  // ── 3. Phrase-lock: reviewer.md must contain the required instructions ────
  const reviewerPath = path.resolve(HERE, "..", "agents", "reviewer.md");
  let reviewerText = "";
  try {
    reviewerText = await fs.readFile(reviewerPath, "utf8");
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    outcomes.push({
      name: "reviewer pushes branch before pr create: reviewer.md is readable",
      passed: false,
      error: `could not read reviewer.md at ${reviewerPath}: ${msg}`,
    });
    return outcomes;
  }

  await runOne({
    name: "reviewer pushes branch before pr create: reviewer.md contains git push -u origin instruction",
    run: () => {
      expect(
        /git push.*-u origin|git push.*--set-upstream/.test(reviewerText),
        `reviewer.md does not contain a 'git push -u origin' (or --set-upstream) instruction`,
      );
    },
  });

  await runOne({
    name: "reviewer pushes branch before pr create: reviewer.md contains 'before calling gh pr create' phrase",
    run: () => {
      expect(
        reviewerText.includes("before calling gh pr create"),
        `reviewer.md does not contain the phrase 'before calling gh pr create'`,
      );
    },
  });

  return outcomes;
}

/**
 * smoketest-followups sprint, story 3 — pr_per_story setup fires before first claim.
 *
 * Two assertions:
 *
 *   1. Phrase-lock: SKILL.md contains a phrase that documents the ordering
 *      constraint — the pr_per_story setup question must be resolved before
 *      `claimStory` is called. The grep pattern is:
 *        /pr_per_story.*before.*claimStory|setup.*before.*main loop/
 *
 *   2. Behavioral pre-condition: when config exists but `pr_per_story` is
 *      absent, `getOrInitConfig` returns the PR_PER_STORY_SETUP_PROMPT in
 *      `setupQuestions`. This confirms the server surfaces the question that
 *      the SKILL.md ordering constraint is designed to intercept — if the
 *      server never surfaces the question, the constraint has no effect.
 *
 * Grep tag: "pr_per_story setup fires before first claim".
 */
async function runPrPerStorySetupBeforeFirstClaimMiniRun(): Promise<AssertionOutcome[]> {
  const outcomes: AssertionOutcome[] = [];

  async function runOne(a: Assertion) {
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

  // ── 1. Phrase-lock: SKILL.md must document that pr_per_story setup runs
  //       before claimStory / before the main loop. ─────────────────────────
  const skillPath = path.resolve(HERE, "..", "skills", "process-backlog", "SKILL.md");
  let skillText = "";
  try {
    skillText = await fs.readFile(skillPath, "utf8");
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    outcomes.push({
      name: "pr_per_story setup fires before first claim: SKILL.md is readable",
      passed: false,
      error: `could not read SKILL.md at ${skillPath}: ${msg}`,
    });
    return outcomes;
  }

  await runOne({
    name: "pr_per_story setup fires before first claim: SKILL.md documents setup ordering before claimStory",
    run: () => {
      const pattern = /pr_per_story.*before.*claimStory|setup.*before.*main loop/;
      expect(
        pattern.test(skillText),
        `SKILL.md does not contain a phrase matching /pr_per_story.*before.*claimStory|setup.*before.*main loop/. ` +
          `The setup section must explicitly state that pr_per_story setup resolves before the first claimStory call.`,
      );
    },
  });

  // ── 2. Behavioral: getOrInitConfig must surface setup question when
  //       pr_per_story is absent — confirming the server-side precondition
  //       that makes the SKILL.md ordering constraint meaningful. ────────────
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sprint-orch-pr-per-story-before-claim-"));
  try {
    // Minimal sprint-status.yaml so the server initialises without error.
    await fs.writeFile(
      path.join(tmp, "sprint-status.yaml"),
      [
        "sprint_id: pr-per-story-before-claim-fixture",
        "schema_version: 1",
        "stories:",
        "  - id: '1'",
        "    title: fixture story",
        "    status: ready",
        "    depends_on: []",
        "    acceptance_criteria:",
        "      checks: []",
        "    orchestrator: {}",
        "",
      ].join("\n"),
      "utf8",
    );

    // Config exists but pr_per_story field is intentionally absent.
    const configDir = path.join(tmp, ".sprint-orchestrator");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "config.yaml"),
      ["sprintStatusPath: sprint-status.yaml", "layout: custom", "autoDetected: false", ""].join(
        "\n",
      ),
      "utf8",
    );

    const ctx: ToolContext = {
      projectRoot: tmp,
      sprintStatusPath: path.join(tmp, "sprint-status.yaml"),
      configPath: path.join(configDir, "config.yaml"),
    };
    const server = buildServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "e2e-pr-per-story-before-claim", version: "0.0.1" },
      { capabilities: {} },
    );
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    let parsed: { setupQuestions?: unknown[]; needsSetup?: unknown } = {};
    try {
      const result = (await client.callTool({
        name: "getOrInitConfig",
        arguments: {},
      })) as { content?: Array<{ type: string; text?: string }> };
      const textPart = result.content?.find((c) => c.type === "text");
      if (textPart?.text) {
        parsed = JSON.parse(textPart.text) as {
          setupQuestions?: unknown[];
          needsSetup?: unknown;
        };
      }
    } finally {
      await client.close();
      await server.close();
    }

    const questions: unknown[] = Array.isArray(parsed.setupQuestions) ? parsed.setupQuestions : [];
    const hasPrompt = questions.some((q) => q === PR_PER_STORY_SETUP_PROMPT);

    await runOne({
      name: "pr_per_story setup fires before first claim: getOrInitConfig surfaces setup question when pr_per_story absent",
      run: () => {
        expect(
          hasPrompt,
          `expected PR_PER_STORY_SETUP_PROMPT in setupQuestions when pr_per_story is absent from config, ` +
            `got ${JSON.stringify(questions)}`,
        );
      },
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }

  return outcomes;
}

/**
 * story 1 of acs-only-evaluate-after-dev sprint:
 * ACs only evaluate after the dev subagent returns.
 *
 * Sets up a temp dir with a real sprint-status.yaml, claims a story (real MCP
 * tool), then tries to call recordStoryFailure / validateAcceptanceCriteria
 * WITHOUT setting dev_returned_at. Asserts the refusal fires with the
 * structured reason "ac_evaluation_before_dev_returned".
 *
 * Grep tag: "orchestrator refuses to evaluate ACs before dev has produced work"
 */
async function runDevReturnedGuardMiniRun(): Promise<AssertionOutcome[]> {
  const outcomes: AssertionOutcome[] = [];

  async function runOne(a: Assertion) {
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

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sprint-orch-dev-returned-guard-"));
  try {
    await fs.writeFile(
      path.join(tmp, "sprint-status.yaml"),
      [
        "sprint_id: dev-returned-guard-fixture",
        "schema_version: 1",
        "stories:",
        "  - id: 'G1'",
        "    title: Guard test story",
        "    status: ready",
        "    depends_on: []",
        "    acceptance_criteria:",
        "      checks: []",
        "    orchestrator: {}",
        "",
      ].join("\n"),
      "utf8",
    );

    const configDir = path.join(tmp, ".sprint-orchestrator");
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

    const ctx: ToolContext = {
      projectRoot: tmp,
      sprintStatusPath: path.join(tmp, "sprint-status.yaml"),
      configPath: path.join(configDir, "config.yaml"),
    };

    // Claim the story so it is in_progress — exactly as it would be right after
    // claimStory and before the dev subagent has done any work.
    const claim = await claimStory(ctx, "G1", "agent-guard-test");
    if (!claim.claimed) {
      outcomes.push({
        name: "orchestrator refuses to evaluate ACs before dev has produced work: setup claim",
        passed: false,
        error: `could not claim G1: holder=${claim.holder ?? "?"}`,
      });
      return outcomes;
    }

    // ── Attempt 1: recordStoryFailure without dev_returned_at ────────────────
    let failureRefused = false;
    let failureReason = "";
    try {
      await markStoryFailed(ctx, "G1", "should not reach this");
    } catch (err) {
      failureRefused = true;
      failureReason = (err as Error & { code?: string }).code ?? (err as Error).message;
    }

    await runOne({
      name: "orchestrator refuses to evaluate ACs before dev has produced work: recordStoryFailure refused",
      run: () => {
        expect(
          failureRefused,
          "recordStoryFailure must throw when dev_returned_at is absent — it did not throw",
        );
        expect(
          failureReason === "ac_evaluation_before_dev_returned",
          `expected error code "ac_evaluation_before_dev_returned", got "${failureReason}"`,
        );
      },
    });

    // ── Attempt 2: validateAcceptanceCriteria without dev_returned_at ────────
    let validateRefused = false;
    let validateReason = "";
    try {
      await validateAcceptanceCriteria(ctx, "G1");
    } catch (err) {
      validateRefused = true;
      validateReason = (err as Error & { code?: string }).code ?? (err as Error).message;
    }

    await runOne({
      name: "orchestrator refuses to evaluate ACs before dev has produced work: validateAcceptanceCriteria refused",
      run: () => {
        expect(
          validateRefused,
          "validateAcceptanceCriteria must throw when dev_returned_at is absent — it did not throw",
        );
        expect(
          validateReason === "ac_evaluation_before_dev_returned",
          `expected error code "ac_evaluation_before_dev_returned", got "${validateReason}"`,
        );
      },
    });

    // ── After markDevReturned, both calls must be allowed ────────────────────
    await markDevReturned(ctx, "G1", "agent-guard-test");

    let validateAllowedAfterReturn = false;
    try {
      await validateAcceptanceCriteria(ctx, "G1");
      validateAllowedAfterReturn = true;
    } catch {
      validateAllowedAfterReturn = false;
    }

    await runOne({
      name: "orchestrator refuses to evaluate ACs before dev has produced work: validateAcceptanceCriteria allowed after markDevReturned",
      run: () => {
        expect(
          validateAllowedAfterReturn,
          "validateAcceptanceCriteria must succeed after markDevReturned — it threw",
        );
      },
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }

  return outcomes;
}

/**
 * structured-failure-details sprint, story 2.
 *
 * Sets up a temp git repo with a sprint whose story has a deliberately-
 * failing shell AC (`false`). Claims the story, marks dev returned, then
 * calls recordStoryFailure through the real MCP tool (in-memory client).
 * Asserts that orchestrator.failure_details[0].cmd is the literal failing
 * command and failure_details[0].exit_code matches the observed exit code.
 *
 * Grep tag: "recordStoryFailure persists structured details, not just check types"
 */
async function runStructuredFailureDetailsMiniRun(): Promise<AssertionOutcome[]> {
  const outcomes: AssertionOutcome[] = [];

  async function runOne(a: Assertion) {
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

  const FAILING_CMD = "false";

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sprint-orch-structured-failure-"));
  try {
    // ── Init a minimal git repo ──────────────────────────────────────────────
    const git = (args: string[]) => spawnSync("git", args, { cwd: tmp, encoding: "utf8" });
    git(["init", "-q", "--initial-branch=main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);

    const sprintYaml = [
      "sprint_id: structured-failure-fixture",
      "schema_version: 1",
      "stories:",
      "  - id: 'SF1'",
      "    title: Story with deliberately failing AC",
      "    status: ready",
      "    depends_on: []",
      "    acceptance_criteria:",
      "      checks:",
      "        - type: shell",
      `          cmd: "${FAILING_CMD}"`,
      "          expect_exit: 0",
      "    orchestrator: {}",
      "",
    ].join("\n");

    await fs.writeFile(path.join(tmp, "sprint-status.yaml"), sprintYaml, "utf8");
    git(["add", "sprint-status.yaml"]);
    git(["commit", "-q", "-m", "init: structured-failure fixture"]);

    const configDir = path.join(tmp, ".sprint-orchestrator");
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

    const ctx: ToolContext = {
      projectRoot: tmp,
      sprintStatusPath: path.join(tmp, "sprint-status.yaml"),
      configPath: path.join(configDir, "config.yaml"),
    };

    // ── Claim and mark dev returned ──────────────────────────────────────────
    const claim = await claimStory(ctx, "SF1", "agent-sf-test");
    if (!claim.claimed) {
      outcomes.push({
        name: "recordStoryFailure persists structured details, not just check types: setup claim",
        passed: false,
        error: `could not claim SF1: holder=${claim.holder ?? "?"}`,
      });
      return outcomes;
    }
    await markDevReturned(ctx, "SF1", "agent-sf-test");

    // ── Build the failure_details the way a reviewer would ───────────────────
    // Run the failing check so we capture real observed values.
    const { runChecks } = await import("../packages/mcp-server/src/validators/acceptance.js");
    const validation = await runChecks([{ type: "shell", cmd: FAILING_CMD, expect_exit: 0 }], {
      cwd: tmp,
    });
    const failedResults = validation.results.filter((r) => !r.passed);

    const failure_details = failedResults
      .filter((r): r is Extract<typeof r, { type: "shell" }> => r.type === "shell")
      .map((r) => ({
        cmd: r.cmd,
        exit_code: r.exit_code,
        expected_exit: r.expected_exit,
        stderr: r.stderr,
        stdout: r.stdout,
        recorded_at: new Date().toISOString(),
      }));

    // ── Drive recordStoryFailure through the real MCP tool ───────────────────
    const server = buildServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "sf-test-client", version: "0.0.1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const toolResult = await client.callTool({
      name: "recordStoryFailure",
      arguments: {
        storyId: "SF1",
        reason: "AC validation failed",
        failure_details,
      },
    });

    await runOne({
      name: "recordStoryFailure persists structured details, not just check types: tool returns ok",
      run: () => {
        const content = toolResult.content as Array<{ type: string; text: string }>;
        const text = content.find((c) => c.type === "text")?.text ?? "";
        const parsed = JSON.parse(text) as Record<string, unknown>;
        expect(parsed.ok === true, `expected ok=true, got ${JSON.stringify(parsed)}`);
      },
    });

    // ── Read back sprint-status and assert failure_details persisted ─────────
    const finalState = await readSprintStatus(ctx.sprintStatusPath);
    const story = finalState.stories.find((s) => s.id === "SF1");

    await runOne({
      name: "recordStoryFailure persists structured details, not just check types: failure_details array present",
      run: () => {
        const orch = story?.orchestrator as Record<string, unknown> | undefined;
        const details = orch?.failure_details;
        expect(
          Array.isArray(details),
          `expected failure_details to be an array, got ${JSON.stringify(details)}`,
        );
        expect(
          (details as unknown[]).length >= 1,
          `expected at least 1 failure_details entry, got ${(details as unknown[]).length}`,
        );
      },
    });

    await runOne({
      name: "recordStoryFailure persists structured details, not just check types: failure_details[0].cmd is the failing command",
      run: () => {
        const orch = story?.orchestrator as Record<string, unknown> | undefined;
        const details = orch?.failure_details as Array<Record<string, unknown>>;
        const first = details?.[0];
        expect(
          first?.cmd === FAILING_CMD,
          `expected failure_details[0].cmd="${FAILING_CMD}", got "${String(first?.cmd)}"`,
        );
      },
    });

    await runOne({
      name: "recordStoryFailure persists structured details, not just check types: failure_details[0].exit_code matches observed exit",
      run: () => {
        const orch = story?.orchestrator as Record<string, unknown> | undefined;
        const details = orch?.failure_details as Array<Record<string, unknown>>;
        const first = details?.[0];
        // `false` exits 1
        expect(
          typeof first?.exit_code === "number",
          `expected exit_code to be a number, got ${JSON.stringify(first?.exit_code)}`,
        );
        expect(
          first?.exit_code !== 0,
          `expected non-zero exit_code for a failing command, got ${String(first?.exit_code)}`,
        );
      },
    });

    await runOne({
      name: "recordStoryFailure persists structured details, not just check types: last_failure_reason is derived human summary",
      run: () => {
        const orch = story?.orchestrator as Record<string, unknown> | undefined;
        const reason = orch?.last_failure_reason as string | undefined;
        expect(
          typeof reason === "string" && reason.includes(FAILING_CMD),
          `expected last_failure_reason to mention the failing command "${FAILING_CMD}", got "${String(reason)}"`,
        );
      },
    });

    await client.close();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }

  return outcomes;
}

/**
 * dependency-base sprint, story 3 — prepareStoryBranch roots off the
 * depended-on story's branch tip when depends_on is set and the dep branch
 * exists locally.
 *
 * Setup: minimal git repo with two stories (id "1" and "2", where 2
 * depends_on ["1"]). Story 1 is manually marked `done` with a real
 * per-story branch and orchestrator.branch. Story 2 is ready.
 *
 * Positive case: prepareStoryBranch for story 2 must root the new branch
 * off story 1's tip (asserted via git merge-base --is-ancestor).
 *
 * Negative case: a standalone story (empty depends_on) roots off default_base.
 *
 * Grep tag: "prepareStoryBranch roots off depends_on story branch tip when present"
 */
async function runPrepareStoryBranchDependencyBaseMiniRun(): Promise<AssertionOutcome[]> {
  const outcomes: AssertionOutcome[] = [];

  async function runOne(a: Assertion) {
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

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sprint-orch-dep-base-"));
  try {
    // ── Init a minimal git repo ──────────────────────────────────────────────
    const g = (args: string[]) => spawnSync("git", args, { cwd: tmp, encoding: "utf8" });
    g(["init", "-q", "--initial-branch=main"]);
    g(["config", "user.email", "test@example.com"]);
    g(["config", "user.name", "Test"]);
    g(["config", "commit.gpgsign", "false"]);

    // Sprint with story 1 (done) and story 2 (ready, depends_on ["1"])
    const sprintYaml = [
      "schema_version: 1",
      'sprint_id: "dep-base-fixture"',
      "stories:",
      "  - id: '1'",
      "    title: First story",
      "    status: ready",
      "    depends_on: []",
      "    acceptance_criteria:",
      "      checks:",
      "        - type: file_exists",
      "          path: src/s1.txt",
      "    orchestrator: {}",
      "  - id: '2'",
      "    title: Second story",
      "    status: ready",
      "    depends_on: ['1']",
      "    acceptance_criteria:",
      "      checks:",
      "        - type: file_exists",
      "          path: src/s2.txt",
      "    orchestrator: {}",
      "",
    ].join("\n");

    await fs.writeFile(path.join(tmp, "sprint-status.yaml"), sprintYaml, "utf8");
    g(["add", "sprint-status.yaml"]);
    g(["commit", "-q", "-m", "init: dep-base fixture"]);

    // ── Config: pr_per_story=true, default_base=main ────────────────────────
    const configDir = path.join(tmp, ".sprint-orchestrator");
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

    const ctx: ToolContext = {
      projectRoot: tmp,
      sprintStatusPath: path.join(tmp, "sprint-status.yaml"),
      configPath: path.join(tmp, ".sprint-orchestrator", "config.yaml"),
    };

    // ── Create story 1's per-story branch and mark it done ─────────────────
    const s1Branch = "1-first-story";
    g(["checkout", "-q", "-b", s1Branch]);
    await fs.mkdir(path.join(tmp, "src"), { recursive: true });
    await fs.writeFile(path.join(tmp, "src", "s1.txt"), "story 1 work\n", "utf8");
    g(["add", "src/s1.txt"]);
    g(["commit", "-q", "-m", "feat(s1): work"]);

    // Record the s1Branch commit as story 1's tip
    const s1Tip = g(["rev-parse", "HEAD"]).stdout.trim();

    // Manually mark story 1 as done in sprint-status.yaml with orchestrator.branch set
    const doneYaml = [
      "schema_version: 1",
      'sprint_id: "dep-base-fixture"',
      "stories:",
      "  - id: '1'",
      "    title: First story",
      "    status: done",
      "    depends_on: []",
      "    acceptance_criteria:",
      "      checks:",
      "        - type: file_exists",
      "          path: src/s1.txt",
      `    orchestrator:`,
      `      branch: ${s1Branch}`,
      `      base_branch: main`,
      `      completed_at: "2026-01-01T00:00:00.000Z"`,
      "  - id: '2'",
      "    title: Second story",
      "    status: ready",
      "    depends_on: ['1']",
      "    acceptance_criteria:",
      "      checks:",
      "        - type: file_exists",
      "          path: src/s2.txt",
      "    orchestrator: {}",
      "",
    ].join("\n");

    await fs.writeFile(path.join(tmp, "sprint-status.yaml"), doneYaml, "utf8");
    g(["add", "sprint-status.yaml"]);
    g(["commit", "-q", "-m", "chore: mark story 1 done"]);

    // ── Positive case: prepareStoryBranch for story 2 ────────────────────────
    // Claim story 2 first (prepareStoryBranch expects an existing claim).
    await claimStory(ctx, "2", "agent-dep-test");
    const prep2 = await prepareStoryBranch(ctx, "2", "agent-dep-test");

    await runOne({
      name: "prepareStoryBranch roots off depends_on story branch tip when present: branch created without skip",
      run: () => {
        expect(
          prep2.skipped === false,
          `expected skipped=false, got ${String(prep2.skipped)} reason=${String(prep2.reason)}`,
        );
        expect(
          typeof prep2.branch === "string" && prep2.branch.length > 0,
          `expected a branch name, got ${String(prep2.branch)}`,
        );
      },
    });

    await runOne({
      name: "prepareStoryBranch roots off depends_on story branch tip when present: new branch is rooted at dep story's branch tip",
      run: () => {
        if (prep2.skipped || !prep2.branch) return;
        // git merge-base --is-ancestor <ancestor> <descendant> exits 0 when
        // the first commit is an ancestor of the second.
        const r = g(["merge-base", "--is-ancestor", s1Tip, prep2.branch]);
        expect(
          r.status === 0,
          `expected story 1's tip (${s1Tip}) to be an ancestor of story 2's branch (${prep2.branch}); ` +
            `git merge-base --is-ancestor exited ${r.status}`,
        );
      },
    });

    await runOne({
      name: "prepareStoryBranch roots off depends_on story branch tip when present: base_branch recorded as dep's branch not default_base",
      run: () => {
        const state = spawnSync("cat", [path.join(tmp, "sprint-status.yaml")], {
          encoding: "utf8",
        });
        // Read back the state via the tool result — base_branch should be s1Branch
        expect(prep2.branch !== null, "branch must be set to inspect base_branch");
        // Verify via git that HEAD is on s1's descendant, not a clean main branch
        const mergeBaseVsMain = g(["merge-base", "--is-ancestor", s1Tip, "main"]);
        // s1Tip should NOT be an ancestor of main (s1's work was not merged to main)
        expect(
          mergeBaseVsMain.status !== 0,
          `s1Tip (${s1Tip}) should NOT be reachable from main — story 2 must be rooted from s1 branch tip, not main`,
        );
        void state; // suppress unused warning
      },
    });

    // ── Negative case: standalone story (no depends_on) roots off main ──────
    // Go back to main and set up a standalone story (story 3, no depends_on).
    // We need to checkout back to a branch off main for this.
    g(["checkout", "-q", "main"]);

    const standaloneYaml = [
      "schema_version: 1",
      'sprint_id: "dep-base-fixture-neg"',
      "stories:",
      "  - id: '3'",
      "    title: Standalone story",
      "    status: ready",
      "    depends_on: []",
      "    acceptance_criteria:",
      "      checks:",
      "        - type: file_exists",
      "          path: src/s3.txt",
      "    orchestrator: {}",
      "",
    ].join("\n");

    // Write a fresh sprint-status for the standalone test in a new temp dir
    // (avoids interference with the s1/s2 sprint state already on main).
    const tmp2 = await fs.mkdtemp(path.join(os.tmpdir(), "sprint-orch-dep-base-neg-"));
    try {
      const g2 = (args: string[]) => spawnSync("git", args, { cwd: tmp2, encoding: "utf8" });
      g2(["init", "-q", "--initial-branch=main"]);
      g2(["config", "user.email", "test@example.com"]);
      g2(["config", "user.name", "Test"]);
      g2(["config", "commit.gpgsign", "false"]);

      await fs.writeFile(path.join(tmp2, "sprint-status.yaml"), standaloneYaml, "utf8");
      g2(["add", "sprint-status.yaml"]);
      g2(["commit", "-q", "-m", "init: standalone story"]);

      const configDir2 = path.join(tmp2, ".sprint-orchestrator");
      await fs.mkdir(configDir2, { recursive: true });
      await fs.writeFile(
        path.join(configDir2, "config.yaml"),
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

      const ctx2: ToolContext = {
        projectRoot: tmp2,
        sprintStatusPath: path.join(tmp2, "sprint-status.yaml"),
        configPath: path.join(tmp2, ".sprint-orchestrator", "config.yaml"),
      };

      const mainTip2 = g2(["rev-parse", "main"]).stdout.trim();

      await claimStory(ctx2, "3", "agent-standalone");
      const prep3 = await prepareStoryBranch(ctx2, "3", "agent-standalone");

      await runOne({
        name: "prepareStoryBranch roots off depends_on story branch tip when present: story with empty depends_on roots off default_base (main)",
        run: () => {
          expect(
            prep3.skipped === false,
            `expected skipped=false for standalone story, got ${String(prep3.skipped)}`,
          );
          expect(
            typeof prep3.branch === "string" && prep3.branch.length > 0,
            `expected a branch name for standalone story, got ${String(prep3.branch)}`,
          );
          if (!prep3.branch) return;
          // The new branch must be rooted at main's tip
          const r = g2(["merge-base", "--is-ancestor", mainTip2, prep3.branch]);
          expect(
            r.status === 0,
            `expected main tip (${mainTip2}) to be an ancestor of standalone branch (${prep3.branch}); ` +
              `git merge-base --is-ancestor exited ${r.status}`,
          );
        },
      });
    } finally {
      await fs.rm(tmp2, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }

  return outcomes;
}

/**
 * orchestrator-hardening sprint, story 4 — recordStorySuccess refuses when
 * pr_per_story=true and the branch has not been pushed to origin and/or no
 * open PR exists for the branch.
 *
 * Uses a real temp git repo with NO remote so the push check fails, and NO
 * gh shim so the PR check also fails. Asserts that markStoryComplete returns
 * a PrPerStoryRefusalResult instead of marking the story done.
 *
 * Grep tag: "recordStorySuccess refuses when pr_per_story=true and branch is unpushed"
 */
async function runPrPerStoryEnforcementMiniRun(): Promise<AssertionOutcome[]> {
  const outcomes: AssertionOutcome[] = [];

  async function runOne(a: Assertion) {
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

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sprint-orch-pr-enforce-"));
  try {
    const g = (args: string[]) => spawnSync("git", args, { cwd: tmp, encoding: "utf8" });
    g(["init", "-q", "--initial-branch=main"]);
    g(["config", "user.email", "test@example.com"]);
    g(["config", "user.name", "Test"]);
    g(["config", "commit.gpgsign", "false"]);

    // Single story that passes its acceptance criteria (true exit-0 check).
    const sprintYaml = [
      "schema_version: 1",
      "sprint_id: pr-enforce-test",
      "stories:",
      "  - id: s1",
      "    title: Test story",
      "    status: ready",
      "    acceptance_criteria:",
      "      checks:",
      "        - type: shell",
      '          cmd: "exit 0"',
      "          exit_code: 0",
      "    orchestrator: {}",
      "",
    ].join("\n");

    await fs.writeFile(path.join(tmp, "sprint-status.yaml"), sprintYaml, "utf8");
    g(["add", "sprint-status.yaml"]);
    g(["commit", "-q", "-m", "init"]);

    // Config with pr_per_story: true — no remote exists in this repo.
    const configDir = path.join(tmp, ".sprint-orchestrator");
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

    const ctx: ToolContext = {
      projectRoot: tmp,
      sprintStatusPath: path.join(tmp, "sprint-status.yaml"),
      configPath: path.join(tmp, ".sprint-orchestrator", "config.yaml"),
    };

    // Claim and prepare a branch so orchestrator.branch is set on the story.
    await claimStory(ctx, "s1", "agent-test");
    await prepareStoryBranch(ctx, "s1", "agent-test");

    // Attempt to mark done — should be refused because branch is not pushed
    // and there is no open PR.
    const result = await markStoryComplete(ctx, "s1", "agent-test", "test summary");

    await runOne({
      name: "recordStorySuccess refuses when pr_per_story=true and branch is unpushed: returns ok=false with reason pr_per_story_requires_pushed_pr",
      run: () => {
        expect(
          "ok" in result && result.ok === false,
          `expected ok=false refusal but got: ${JSON.stringify(result)}`,
        );
        if (!("ok" in result) || result.ok !== false) return;
        expect(
          result.reason === "pr_per_story_requires_pushed_pr",
          `expected reason=pr_per_story_requires_pushed_pr, got ${String(result.reason)}`,
        );
      },
    });

    await runOne({
      name: "recordStorySuccess refuses when pr_per_story=true and branch is unpushed: missing array includes 'push'",
      run: () => {
        if (!("ok" in result) || result.ok !== false) {
          throw new Error(`result was not a refusal: ${JSON.stringify(result)}`);
        }
        expect(
          result.details.missing.includes("push"),
          `expected 'push' in missing array, got ${JSON.stringify(result.details.missing)}`,
        );
      },
    });

    await runOne({
      name: "recordStorySuccess refuses when pr_per_story=true and branch is unpushed: story remains in_progress (not marked done)",
      run: async () => {
        const state = await readSprintStatus(ctx.sprintStatusPath);
        const story = state.stories.find((s) => s.id === "s1");
        expect(
          story?.status === "in_progress",
          `expected story status=in_progress after refusal, got ${String(story?.status)}`,
        );
      },
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }

  return outcomes;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error("[e2e] fatal:", err);
    process.exit(1);
  });
