import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * Append a single JSON-lines entry to `.sprint-orchestrator/run.log` under
 * `projectRoot`. State-mutator tools call this so every transition leaves
 * an auditable trail without relying on git commits (which we no longer
 * create for state changes — see story 1 of the
 * orchestrator-state-and-shipgate sprint).
 *
 * Best-effort: errors are swallowed. A failed audit append must never block
 * the state machine.
 */
export async function appendRunLog(
  projectRoot: string,
  entry: Record<string, unknown>,
): Promise<void> {
  const dir = path.join(projectRoot, ".sprint-orchestrator");
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, "run.log"), `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // run.log is an audit artefact, not a correctness mechanism. If we
    // cannot write it (read-only fs, disk full, racing rm -rf), the
    // state-machine transition still succeeded — there is no useful
    // recovery from this layer.
  }
}

/**
 * Convenience for state-machine transitions. Emits a uniform `state_mutation`
 * event so a downstream reader (retro / debugging) can reconstruct the
 * sequence of transitions without joining against tool names.
 */
export async function logStateMutation(
  projectRoot: string,
  detail: {
    tool: string;
    story_id: string;
    transition: string;
    agent_id?: string;
    reason?: string;
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  await appendRunLog(projectRoot, {
    event: "state_mutation",
    at: new Date().toISOString(),
    tool: detail.tool,
    story_id: detail.story_id,
    transition: detail.transition,
    ...(detail.agent_id !== undefined ? { agent_id: detail.agent_id } : {}),
    ...(detail.reason !== undefined ? { reason: detail.reason } : {}),
    ...(detail.extra ?? {}),
  });
}
