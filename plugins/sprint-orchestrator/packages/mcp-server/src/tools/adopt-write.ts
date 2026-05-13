import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";
import { lintSprint } from "./lint-sprint.js";
import { defaultContext } from "./context.js";

/**
 * Input to {@link validateAndWriteBacklog}.
 *
 * - `proposalYaml`: the candidate sprint-status.yaml document, as a string.
 * - `destPath`: absolute path to write to on success.
 * - `existingYaml`: the current contents of `destPath`, or `null`/empty when
 *   the destination does not yet exist. Used to check for in-flight stories
 *   without re-reading the file ourselves.
 * - `force`: when `true`, bypass the in-flight refusal. The lint gate still
 *   applies.
 */
export interface ValidateAndWriteInput {
  proposalYaml: string;
  destPath: string;
  existingYaml: string | null;
  force: boolean;
}

export type ValidateAndWriteResult = { ok: true; dest: string } | { ok: false; reason: string };

interface MinimalStory {
  id?: unknown;
  status?: unknown;
}

interface MinimalSprint {
  stories?: unknown;
}

/**
 * Pure helper that validates an adopt-proposed sprint-status.yaml and, on
 * success, writes it atomically to disk.
 *
 * Steps:
 *   1. If `existingYaml` is non-empty and contains a story with
 *      `status: in_progress`, refuse unless `force` is true. The refusal
 *      message names the in-flight story id so the caller can surface it.
 *   2. Validate the proposal by running `lintSprint` against it. Lint runs on
 *      a temp file so we reuse the schema check used everywhere else in the
 *      orchestrator. Any zod/parse failure surfaces as a refusal with the
 *      verbatim error message. Any lint issue of severity `error` is also
 *      treated as a refusal (warnings are allowed through).
 *   3. Write the proposal atomically: `destPath.tmp-<pid>-<ts>` then
 *      `fs.rename` onto `destPath`. POSIX rename is atomic on the same
 *      filesystem, so a refusal partway through never corrupts the
 *      destination.
 *
 * No imports from `skills/adopt/` and no calls from the orchestrator core
 * touch this module — coupling is one-way (NFR1, NFR2).
 */
export async function validateAndWriteBacklog(
  input: ValidateAndWriteInput,
): Promise<ValidateAndWriteResult> {
  const { proposalYaml, destPath, existingYaml, force } = input;

  // 1. In-flight refusal.
  if (!force && existingYaml && existingYaml.trim().length > 0) {
    const inflight = findInProgressStoryId(existingYaml);
    if (inflight !== null) {
      return {
        ok: false,
        reason:
          `refusing to overwrite ${destPath}: story "${inflight}" is in_progress. ` +
          `Re-invoke with --force to overwrite anyway.`,
      };
    }
  }

  // 2. Lint the proposal by writing it to a temp file and reusing lintSprint.
  const lintTmp = path.join(
    os.tmpdir(),
    `adopt-lint-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.yaml`,
  );
  try {
    await fs.writeFile(lintTmp, proposalYaml, "utf8");
    let report;
    try {
      report = await lintSprint(defaultContext(), { sprintStatusPath: lintTmp });
    } catch (err) {
      return {
        ok: false,
        reason: `proposal failed validation: ${formatError(err)}`,
      };
    }
    const errors = report.issues.filter((i) => i.severity === "error");
    if (errors.length > 0) {
      return {
        ok: false,
        reason: `proposal failed lintSprint:\n${report.rendered}`,
      };
    }
  } finally {
    await fs.rm(lintTmp, { force: true }).catch(() => undefined);
  }

  // 3. Atomic write.
  const writeTmp = `${destPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(writeTmp, proposalYaml, "utf8");
    await fs.rename(writeTmp, destPath);
  } catch (err) {
    await fs.rm(writeTmp, { force: true }).catch(() => undefined);
    return {
      ok: false,
      reason: `failed to write ${destPath}: ${formatError(err)}`,
    };
  }

  return { ok: true, dest: destPath };
}

/**
 * Parse existing YAML and return the id of the first story whose
 * `status` is `in_progress`, or `null` if there is no such story (including
 * the cases where the YAML doesn't parse, has no stories, or has no
 * recognisable id). We do NOT throw from this helper — a malformed existing
 * file should not block the adopt path; the user clearly wants to replace it.
 */
function findInProgressStoryId(existingYaml: string): string | null {
  let parsed: unknown;
  try {
    parsed = YAML.parse(existingYaml);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const stories = (parsed as MinimalSprint).stories;
  if (!Array.isArray(stories)) return null;
  for (const raw of stories) {
    if (raw === null || typeof raw !== "object") continue;
    const s = raw as MinimalStory;
    if (s.status === "in_progress") {
      if (typeof s.id === "string" && s.id.length > 0) return s.id;
      return "<unnamed>";
    }
  }
  return null;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
