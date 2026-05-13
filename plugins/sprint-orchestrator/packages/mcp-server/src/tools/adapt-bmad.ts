import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";

/**
 * Input to {@link adaptBmadOutput}.
 *
 * - `bmadOutputDir`: absolute (or caller-resolved) path to a directory whose
 *   shape follows the BMad-side convention documented in the sprint notes
 *   for story 1 (planning-artifacts/epics.md + implementation-artifacts/*.md).
 */
export interface AdaptBmadInput {
  bmadOutputDir: string;
}

export type AdaptBmadResult = { ok: true; proposalYaml: string } | { ok: false; reason: string };

/**
 * BMad story heading parsed from epics.md.
 *
 * - `bmadKey`: the BMad "epic.story" identifier (e.g. `1.2`). Preserved in the
 *   generated sprint-status.yaml's notes field for traceability.
 * - `title`: the story title from the epic doc heading.
 */
interface BmadStoryRef {
  bmadKey: string;
  title: string;
}

/**
 * Heading regex for the epics doc. We accept either H2 or H3 headings of the
 * shape `## Story 1.1: Title here` (case-sensitive on "Story"). The dot form is
 * canonical inside the epic doc; we translate to dash form for filenames in
 * implementation-artifacts/.
 */
const EPIC_STORY_HEADING = /^#{2,3}\s+Story\s+(\d+\.\d+)\s*[:\-—–]\s*(.+?)\s*$/;

/**
 * Heading regex for the Verification section inside a story file. Case-sensitive
 * on "Verification"; matches H2 only — we don't want to accidentally pick up
 * a deeper subheading.
 */
const VERIFICATION_HEADING = /^##\s+Verification\s*$/;

/**
 * Fenced shell block opener. Accepts ```` ```shell ```` and ```` ```sh ````,
 * trailing whitespace tolerated. The closing fence is just ```` ``` ```` on its
 * own line.
 */
const SHELL_FENCE_OPEN = /^```(?:shell|sh|bash)\s*$/;
const FENCE_CLOSE = /^```\s*$/;

/**
 * `# expect_exit: N` comment line inside a shell fence. When absent the check
 * defaults to `expect_exit: 0`.
 */
const EXPECT_EXIT_COMMENT = /^#\s*expect_exit:\s*(-?\d+)\s*$/;

/**
 * Deterministically adapt a BMad output directory into a conforming
 * sprint-status.yaml proposal.
 *
 * On success returns the YAML string (caller hands it to
 * `validateAndWriteBacklog` for the lint + atomic write — this helper is pure
 * and does not touch disk except for the reads it advertises).
 *
 * Refuses with a clear reason on any of:
 *  - epic doc missing or unreadable
 *  - epic doc contains zero recognisable `## Story X.Y: Title` headings
 *  - any referenced story file is missing or unreadable
 *  - any story file lacks a `## Verification` section
 *  - any story file's Verification section yields zero shell commands
 *  - any shell fence inside Verification is malformed (unclosed, empty, or
 *    `expect_exit` comment with non-integer value)
 */
export async function adaptBmadOutput(input: AdaptBmadInput): Promise<AdaptBmadResult> {
  const { bmadOutputDir } = input;

  const epicPath = path.join(bmadOutputDir, "planning-artifacts", "epics.md");
  let epicText: string;
  try {
    epicText = await fs.readFile(epicPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: `cannot read BMad epic doc at ${epicPath}: ${formatError(err)}`,
    };
  }

  const refs = parseEpicHeadings(epicText);
  if (refs.length === 0) {
    return {
      ok: false,
      reason:
        `no BMad story headings found in ${epicPath}. ` +
        `Expected headings of the form "## Story 1.1: Title".`,
    };
  }

  const stories: Array<Record<string, unknown>> = [];
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i]!;
    const storyFilename = bmadKeyToFilename(ref.bmadKey);
    const storyPath = path.join(bmadOutputDir, "implementation-artifacts", storyFilename);

    let storyText: string;
    try {
      storyText = await fs.readFile(storyPath, "utf8");
    } catch (err) {
      return {
        ok: false,
        reason: `cannot read BMad story file at ${storyPath}: ${formatError(err)}`,
      };
    }

    const verificationResult = extractVerificationChecks(storyText, storyPath);
    if (!verificationResult.ok) {
      return verificationResult;
    }

    const orchestratorId = String(i + 1);
    const story: Record<string, unknown> = {
      id: orchestratorId,
      title: ref.title,
      status: "ready",
      depends_on: i === 0 ? [] : [String(i)],
      acceptance_criteria: { checks: verificationResult.checks },
      orchestrator: {},
      notes: `BMad story ${ref.bmadKey} — source: ${storyPath}`,
    };
    stories.push(story);
  }

  const sprintId = deriveSprintId(refs[0]!.bmadKey);
  const doc = {
    sprint_id: sprintId,
    stories,
  };

  // YAML.stringify produces stable output; we lock no specific style here —
  // lintSprint parses YAML, so any conforming serialisation is fine.
  const proposalYaml = YAML.stringify(doc);
  return { ok: true, proposalYaml };
}

/**
 * Scan the epic doc top-to-bottom and return story refs in document order.
 * We do not enforce contiguous numbering — if an epic skips a story number
 * (e.g. 1.1, 1.3), we still emit two orchestrator stories in the order found.
 * The BMad key is preserved verbatim in notes so the traceability is auditable.
 */
function parseEpicHeadings(text: string): BmadStoryRef[] {
  const refs: BmadStoryRef[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const m = EPIC_STORY_HEADING.exec(line);
    if (!m) continue;
    refs.push({ bmadKey: m[1]!, title: m[2]!.trim() });
  }
  return refs;
}

/**
 * Translate a BMad epic.story key (e.g. `1.2`) into the implementation-artifact
 * filename (`1-2.md`). Dots are awkward in filesystems and in shell globs; the
 * dash form is the convention.
 */
function bmadKeyToFilename(bmadKey: string): string {
  return `${bmadKey.replace(/\./g, "-")}.md`;
}

/**
 * Derive a sprint id from the first story's BMad key. `1.1` → `bmad-epic-1`.
 * This is a best-effort handle for humans; the orchestrator does not depend
 * on the exact value, only that it is a non-empty string.
 */
function deriveSprintId(firstBmadKey: string): string {
  const epicNum = firstBmadKey.split(".")[0] ?? "1";
  return `bmad-epic-${epicNum}`;
}

interface VerificationOk {
  ok: true;
  checks: Array<{ type: "shell"; cmd: string; expect_exit: number }>;
}
type VerificationResult = VerificationOk | { ok: false; reason: string };

/**
 * Find the `## Verification` section in a story file and parse every fenced
 * shell block inside it into a shell check.
 *
 * The section spans from the `## Verification` heading to the next heading of
 * equal or higher level (or end-of-file). Inside the section, every
 * ```` ```shell ```` (or `sh`/`bash`) fence becomes one check; the fence body
 * is treated as the command, with `# expect_exit: N` comment lines stripped
 * out and applied to the check's `expect_exit`.
 *
 * Refusals:
 *  - section missing → "lacks a ## Verification section"
 *  - section present but yields zero shell commands → "Verification section is empty"
 *  - fence opened but never closed → "malformed shell fence (unclosed)"
 *  - fence body has no non-comment lines → "malformed shell fence (no command)"
 *  - `# expect_exit:` value not an integer → "malformed expect_exit comment"
 */
function extractVerificationChecks(text: string, storyPath: string): VerificationResult {
  const lines = text.split(/\r?\n/);
  let headingIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (VERIFICATION_HEADING.test(lines[i]!)) {
      headingIndex = i;
      break;
    }
  }
  if (headingIndex === -1) {
    return {
      ok: false,
      reason: `${storyPath} lacks a ## Verification section`,
    };
  }

  // Section ends at the next heading of equal-or-higher level (## or #).
  let endIndex = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (/^#{1,2}\s+\S/.test(lines[i]!)) {
      endIndex = i;
      break;
    }
  }

  const checks: Array<{ type: "shell"; cmd: string; expect_exit: number }> = [];
  let i = headingIndex + 1;
  while (i < endIndex) {
    const line = lines[i]!;
    if (SHELL_FENCE_OPEN.test(line)) {
      // Walk until matching FENCE_CLOSE.
      const bodyLines: string[] = [];
      let closed = false;
      let j = i + 1;
      for (; j < endIndex; j++) {
        if (FENCE_CLOSE.test(lines[j]!)) {
          closed = true;
          break;
        }
        bodyLines.push(lines[j]!);
      }
      if (!closed) {
        return {
          ok: false,
          reason: `${storyPath} has a malformed shell fence in Verification (unclosed)`,
        };
      }

      // Parse `# expect_exit: N` comments and strip them.
      let expectExit = 0;
      const commandLines: string[] = [];
      for (const bl of bodyLines) {
        const ee = EXPECT_EXIT_COMMENT.exec(bl);
        if (ee) {
          const n = Number(ee[1]!);
          if (!Number.isInteger(n)) {
            return {
              ok: false,
              reason: `${storyPath} has a malformed expect_exit comment in Verification`,
            };
          }
          expectExit = n;
          continue;
        }
        commandLines.push(bl);
      }
      const cmd = commandLines.join("\n").trim();
      if (cmd.length === 0) {
        return {
          ok: false,
          reason: `${storyPath} has a malformed shell fence in Verification (no command)`,
        };
      }
      checks.push({ type: "shell", cmd, expect_exit: expectExit });
      i = j + 1;
      continue;
    }
    // Catch an opening fence that is not shell/sh/bash — that's a sign the
    // author intended a verification block but mistyped the language tag.
    // We refuse so it isn't silently ignored.
    if (/^```\S+/.test(line) && !SHELL_FENCE_OPEN.test(line)) {
      return {
        ok: false,
        reason:
          `${storyPath} has a malformed shell fence in Verification ` +
          `(expected language tag "shell"/"sh"/"bash")`,
      };
    }
    i++;
  }

  if (checks.length === 0) {
    return {
      ok: false,
      reason: `${storyPath} Verification section contains no shell command blocks`,
    };
  }

  return { ok: true, checks };
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
