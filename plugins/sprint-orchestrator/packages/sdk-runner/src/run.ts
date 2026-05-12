import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { decide } from "./policy.js";
import { defaultStreams, emit, log, type Streams } from "./logger.js";
import { readSprintStatus } from "@sprint-orchestrator/mcp-server/dist/state/sprint-status.js";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_MAX_RUNTIME = 2;

const DEFAULT_ITERATION_PAUSE_MS = 30_000;
const HARD_TURN_CAP = 100;

export interface RunOptions {
  projectRoot: string;
  pluginPath: string;
  maxRuntimeMs?: number;
  /** Pause between iterations to let the host catch up. Defaults to 30s. */
  iterationPauseMs?: number;
  streams?: Streams;
  /** Test hook: replace the SDK `query` function. Defaults to the real one. */
  queryFn?: typeof query;
  /** Test hook: signal that the loop should stop after the current iteration. */
  abort?: AbortController;
}

/**
 * Run the orchestrator backlog loop unattended.
 *
 * Returns one of:
 *   - EXIT_OK (0): backlog drained
 *   - EXIT_ERROR (1): unrecoverable error
 *   - EXIT_MAX_RUNTIME (2): runtime ceiling hit
 */
export async function run(opts: RunOptions): Promise<number> {
  const streams = opts.streams ?? defaultStreams;
  const maxRuntimeMs = opts.maxRuntimeMs ?? 4 * 60 * 60 * 1000;
  const iterationPauseMs = opts.iterationPauseMs ?? DEFAULT_ITERATION_PAUSE_MS;
  const queryFn = opts.queryFn ?? query;
  const startedAt = Date.now();

  let shuttingDown = false;
  const onSignal = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(streams, `received ${sig}; will exit after current iteration`);
    opts.abort?.abort();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  emit(streams, { event: "run_started", projectRoot: opts.projectRoot, pluginPath: opts.pluginPath });

  while (Date.now() - startedAt < maxRuntimeMs && !shuttingDown) {
    let iterationProgressed = false;
    const beforeDoneIds = await listDoneIds(opts.projectRoot);

    try {
      for await (const event of queryFn({
        prompt: "/sprint-orchestrator:process-backlog",
        options: {
          cwd: opts.projectRoot,
          plugins: [{ type: "local", path: opts.pluginPath }],
          maxTurns: HARD_TURN_CAP,
          canUseTool: async (name) => {
            const d = decide(name);
            if (d.allow) return { behavior: "allow", updatedInput: {} };
            log(streams, `denied tool ${name}: ${d.reason}`);
            return { behavior: "deny", message: d.reason };
          },
          abortController: opts.abort,
        },
      })) {
        emit(streams, { event: "sdk_event", payload: event });
      }
    } catch (err) {
      emit(streams, { event: "iteration_error", message: (err as Error).message });
      log(streams, `iteration error: ${(err as Error).message}`);
      return EXIT_ERROR;
    }

    const afterDoneIds = await listDoneIds(opts.projectRoot);
    const newlyDone = [...afterDoneIds].filter((id) => !beforeDoneIds.has(id));
    if (newlyDone.length > 0) iterationProgressed = true;
    emit(streams, { event: "iteration_complete", newlyDone });

    if (!iterationProgressed) {
      emit(streams, { event: "backlog_empty" });
      return EXIT_OK;
    }

    await sleep(iterationPauseMs);
  }

  if (shuttingDown) {
    emit(streams, { event: "shutdown" });
    return EXIT_OK;
  }
  emit(streams, { event: "max_runtime_hit", maxRuntimeMs });
  return EXIT_MAX_RUNTIME;
}

async function listDoneIds(projectRoot: string): Promise<Set<string>> {
  const sprintStatusPath = path.join(projectRoot, "sprint-status.yaml");
  try {
    const state = await readSprintStatus(sprintStatusPath);
    return new Set(state.stories.filter((s) => s.status === "done").map((s) => s.id));
  } catch {
    return new Set();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/run.js is at packages/sdk-runner/dist/run.js → plugin root is ../../..
  const pluginPath = path.resolve(here, "..", "..", "..");
  const projectRoot = process.env.SPRINT_PROJECT_ROOT ?? process.cwd();
  run({ projectRoot, pluginPath })
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[sprint-orchestrator-runner]", err);
      process.exit(EXIT_ERROR);
    });
}
