import { readSprintStatus } from "../state/sprint-status.js";
import { type Check, type Story } from "../state/schema.js";
import { type ToolContext } from "./context.js";

/**
 * State-mutator filenames. Stories whose AC checks reference modifications
 * to one of these files are treated as "state-mutator stories" and require
 * an integration AC (a shell check that runs the e2e harness).
 */
export const STATE_MUTATOR_FILES: readonly string[] = [
  "mark-story-complete.ts",
  "mark-story-failed.ts",
  "mark-story-needs-rework.ts",
  "commit-story-artefacts.ts",
  "get-ready-stories.ts",
  "claim-story.ts",
  "release-stale-claims.ts",
  "schema.ts",
];

/** Shell-check anti-patterns we know are flaky or wrong. */
const BAD_SHELL_PATTERNS: ReadonlyArray<{ pattern: RegExp; message: string }> = [
  {
    pattern: /\bvitest\b[^|;&]*--grep\b/,
    message:
      "shell check uses `vitest --grep` which silently no-ops when no test names match; use `-t`/file paths or assert on file output instead",
  },
];

/** Pattern that recognises a likely integration AC (e2e harness invocation). */
const INTEGRATION_PATTERN =
  /\b(pnpm\b[^|;&]*\be2e\b|npm\s+(?:run\s+)?e2e\b|yarn\s+e2e\b|tsx\s+[^\s]*e2e\.ts)/;

export type LintSeverity = "warn" | "error";

export interface LintIssue {
  storyId: string;
  /** Index into the story's `acceptance_criteria.checks` array, or -1 for story-level findings. */
  checkIndex: number;
  severity: LintSeverity;
  message: string;
}

export interface LintReport {
  issues: LintIssue[];
  rendered: string;
}

interface LintInput {
  sprintStatusPath?: string;
}

/** Returns `true` if the check references a state-mutator filename. */
function checkTouchesStateMutator(check: Check): boolean {
  const haystack =
    check.type === "file_exists" ? check.path : check.type === "regex" ? check.cmd : check.cmd;
  return STATE_MUTATOR_FILES.some((f) => haystack.includes(f));
}

/** Returns `true` if a shell check looks like an integration test invocation. */
function isIntegrationCheck(check: Check): boolean {
  if (check.type !== "shell") return false;
  return INTEGRATION_PATTERN.test(check.cmd);
}

/**
 * A regex pattern is "trivially satisfiable" when it is a single literal
 * fragment with no regex metacharacters — a one-line grep that matches
 * if the literal string appears anywhere in the file. Such checks pass as
 * soon as the story name is mentioned in a comment.
 */
function isTrivialRegex(pattern: string): boolean {
  if (pattern.length === 0) return true;
  // Strip simple anchors that don't change the literal nature meaningfully.
  const meta = /[\\^$.*+?()[\]{}|]/;
  return !meta.test(pattern);
}

function lintStory(story: Story): LintIssue[] {
  const issues: LintIssue[] = [];
  const checks = story.acceptance_criteria.checks ?? [];

  const isMutator = checks.some(checkTouchesStateMutator);
  const hasIntegration = checks.some(isIntegrationCheck);

  if (isMutator && !hasIntegration) {
    issues.push({
      storyId: story.id,
      checkIndex: -1,
      severity: "error",
      message:
        "state-mutator story has no integration AC — add a shell check that runs `pnpm e2e` (or equivalent) so the change is exercised end-to-end",
    });
  }

  checks.forEach((check, idx) => {
    if (check.type === "shell") {
      for (const { pattern, message } of BAD_SHELL_PATTERNS) {
        if (pattern.test(check.cmd)) {
          issues.push({ storyId: story.id, checkIndex: idx, severity: "warn", message });
        }
      }
    }
    if (check.type === "regex") {
      if (isTrivialRegex(check.pattern) && checkTouchesStateMutator(check)) {
        issues.push({
          storyId: story.id,
          checkIndex: idx,
          severity: "warn",
          message: `regex AC on state-mutator file is a trivial literal grep ("${check.pattern}") — it passes on any mention of the string; assert on behaviour instead`,
        });
      }
    }
  });

  return issues;
}

function renderReport(sprintId: string, issues: LintIssue[]): string {
  if (issues.length === 0) return `Sprint ${sprintId}: lintSprint clean (0 issues).`;
  const lines: string[] = [`Sprint ${sprintId}: ${issues.length} lint issue(s).`];
  const byStory = new Map<string, LintIssue[]>();
  for (const issue of issues) {
    const list = byStory.get(issue.storyId) ?? [];
    list.push(issue);
    byStory.set(issue.storyId, list);
  }
  for (const [storyId, list] of byStory) {
    lines.push("");
    lines.push(`[${storyId}]`);
    for (const issue of list) {
      const loc = issue.checkIndex >= 0 ? `check[${issue.checkIndex}]` : "story";
      lines.push(`  - ${issue.severity.toUpperCase()} (${loc}): ${issue.message}`);
    }
  }
  return lines.join("\n");
}

/**
 * Lint a sprint-status.yaml for structurally weak acceptance criteria.
 *
 * Read-only. Reports:
 *   - state-mutator stories (touching mark-story-*.ts, commit-story-artefacts.ts,
 *     get-ready-stories.ts, schema.ts, etc.) that lack an integration AC.
 *   - shell checks with known-bad patterns (vitest --grep, ...).
 *   - trivially-satisfiable regex checks (single literal grep on a state-mutator file).
 */
export async function lintSprint(ctx: ToolContext, input: LintInput = {}): Promise<LintReport> {
  const path = input.sprintStatusPath ?? ctx.sprintStatusPath;
  const state = await readSprintStatus(path);
  const issues = state.stories.flatMap(lintStory);
  const rendered = renderReport(state.sprint_id, issues);
  return { issues, rendered };
}
