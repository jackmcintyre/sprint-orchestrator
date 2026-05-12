import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";
import { Writable } from "node:stream";
import { run, EXIT_OK, EXIT_ERROR } from "../src/run.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function makeProject(stories: Array<{ id: string; status: string }>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-"));
  cleanups.push(async () => fs.rm(root, { recursive: true, force: true }));
  const sprint = {
    sprint_id: "t",
    stories: stories.map((s) => ({
      id: s.id,
      title: s.id,
      status: s.status,
      depends_on: [],
      acceptance_criteria: { checks: [] },
      orchestrator: {},
    })),
  };
  await fs.writeFile(path.join(root, "sprint-status.yaml"), YAML.stringify(sprint), "utf8");
  return root;
}

function collectingStreams() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      stdout.push(chunk.toString());
      cb();
    },
  });
  const err = new Writable({
    write(chunk, _enc, cb) {
      stderr.push(chunk.toString());
      cb();
    },
  });
  return { streams: { out, err }, stdout, stderr };
}

// Mock query that flips one story from ready -> done per iteration, so the
// loop genuinely terminates when nothing changes.
function makeQueryMock(projectRoot: string): typeof import("@anthropic-ai/claude-agent-sdk").query {
  return (async function* mockQuery() {
    const sprintPath = path.join(projectRoot, "sprint-status.yaml");
    const raw = await fs.readFile(sprintPath, "utf8");
    const state = YAML.parse(raw) as { stories: Array<{ id: string; status: string }> };
    const next = state.stories.find((s) => s.status === "ready");
    if (next) {
      next.status = "done";
      await fs.writeFile(sprintPath, YAML.stringify(state), "utf8");
      yield { type: "assistant", text: `did ${next.id}` } as unknown;
    } else {
      yield { type: "assistant", text: "nothing to do" } as unknown;
    }
  }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
}

describe("run", () => {
  it("returns EXIT_OK when backlog is already empty", async () => {
    const root = await makeProject([{ id: "A", status: "done" }]);
    const { streams, stdout } = collectingStreams();
    const code = await run({
      projectRoot: root,
      pluginPath: "/tmp/fake-plugin",
      maxRuntimeMs: 5_000,
      streams,
      queryFn: makeQueryMock(root),
    });
    expect(code).toBe(EXIT_OK);
    const log = stdout.join("");
    expect(log).toMatch(/"event":"backlog_empty"/);
  });

  it("loops until all stories are done then exits 0", async () => {
    const root = await makeProject([
      { id: "A", status: "ready" },
      { id: "B", status: "ready" },
    ]);
    const { streams, stdout } = collectingStreams();
    // Override the iteration pause to keep the test fast — read via a thin
    // wrapper that fast-completes by passing maxRuntime sufficient but
    // queryFn drains the backlog immediately.
    const code = await run({
      projectRoot: root,
      pluginPath: "/tmp/fake-plugin",
      maxRuntimeMs: 60_000,
      iterationPauseMs: 0,
      streams,
      queryFn: makeQueryMock(root),
    });
    expect(code).toBe(EXIT_OK);
    const events = stdout.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const newlyDoneIds = events
      .filter((e) => e.event === "iteration_complete")
      .flatMap((e) => e.newlyDone as string[]);
    expect(newlyDoneIds).toEqual(["A", "B"]);
  });

  it("returns EXIT_ERROR when the SDK query throws", async () => {
    const root = await makeProject([{ id: "A", status: "ready" }]);
    const { streams, stderr } = collectingStreams();
    const code = await run({
      projectRoot: root,
      pluginPath: "/tmp/fake-plugin",
      maxRuntimeMs: 5_000,
      streams,
      queryFn: (async function* () {
        throw new Error("boom");
        yield 0; // unreachable; satisfies require-yield
      }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    expect(code).toBe(EXIT_ERROR);
    expect(stderr.join("")).toMatch(/iteration error: boom/);
  });
});
