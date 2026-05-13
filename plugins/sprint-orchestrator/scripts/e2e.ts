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

  // Simulate the dev subagent making code changes.
  if (prepareWorkingTree) await prepareWorkingTree();

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
  return { shasBefore: before, shasAfter: after, commitMessages, filesInLastTwoCommits };
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
  const happy = await driveHappyPathStory(ctx, "A", "agent-A");

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

  // Drive B (the auto-promoted story). Dev creates src/world.txt to satisfy AC.
  let bDriven: DriveResult | null = null;
  if (readyIds.includes("B")) {
    bDriven = await driveHappyPathStory(ctx, "B", "agent-B", async () => {
      await fs.writeFile(path.join(root, "src", "world.txt"), "world\n", "utf8");
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
            f.includes("/node_modules/"),
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
  ];
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
