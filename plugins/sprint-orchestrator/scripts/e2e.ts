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
import { prepareStoryBranch } from "../packages/mcp-server/src/tools/prepare-story-branch.js";
import { type ToolContext } from "../packages/mcp-server/src/tools/context.js";
import { readSprintStatus } from "../packages/mcp-server/src/state/sprint-status.js";
import { appendRunLog } from "../packages/hooks/src/post-tool-use.js";

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
      name: "branch-per-story: story A's commits land on its own branch when flag is on",
      run: () => {
        // pr_per_story defaults to true, so prepareStoryBranch should have
        // checked out a per-story branch named `<id-slug>-<title-slug>`.
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
  if (filter && filtered.length === 0) {
    console.error(`[e2e] --grep ${args.grep} matched 0 assertions`);
    if (!args.keep) await fs.rm(root, { recursive: true, force: true });
    return 1;
  }

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

  const failed = outcomes.filter((o) => !o.passed);
  console.log(
    `\n[e2e] ${outcomes.length - failed.length}/${outcomes.length} assertions passed` +
      (filter ? ` (grep=${args.grep})` : ""),
  );
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error("[e2e] fatal:", err);
    process.exit(1);
  });
