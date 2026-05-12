import { readSprintStatus } from "../state/sprint-status.js";
import { type StoryStatus } from "../state/schema.js";
import { type ToolContext } from "./context.js";

/** One story summarised for the sprint report. */
export interface SprintReportStory {
  id: string;
  title: string;
  status: StoryStatus;
  summary?: string;
  lastFailure?: string;
}

/** Per-status counts for every status the schema knows about. */
export type SprintReportCounts = Record<StoryStatus, number>;

/** Structured + rendered sprint report. */
export interface SprintReport {
  counts: SprintReportCounts;
  stories: SprintReportStory[];
  rendered: string;
}

const STATUS_ORDER: StoryStatus[] = ["backlog", "ready", "in_progress", "done", "blocked"];

function emptyCounts(): SprintReportCounts {
  return {
    backlog: 0,
    ready: 0,
    in_progress: 0,
    done: 0,
    blocked: 0,
  };
}

function renderReport(
  sprintId: string,
  counts: SprintReportCounts,
  stories: SprintReportStory[],
): string {
  const lines: string[] = [];
  lines.push(`Sprint: ${sprintId}`);
  const total = STATUS_ORDER.reduce((acc, s) => acc + counts[s], 0);
  lines.push(
    `Totals: ${total} stories — ` + STATUS_ORDER.map((s) => `${s}=${counts[s]}`).join(", "),
  );

  for (const status of STATUS_ORDER) {
    const inStatus = stories.filter((s) => s.status === status);
    if (inStatus.length === 0) continue;
    lines.push("");
    lines.push(`[${status}] (${inStatus.length})`);
    for (const story of inStatus) {
      let line = `  - ${story.id}: ${story.title}`;
      if (story.summary) line += ` — ${story.summary}`;
      if (story.lastFailure) line += ` (last failure: ${story.lastFailure})`;
      lines.push(line);
    }
  }

  return lines.join("\n");
}

/**
 * Build a read-only sprint report from the current sprint-status.yaml.
 *
 * Returns per-status counts, a per-story summary array, and a rendered
 * multi-line string suitable for chat display. Read-only — does not mutate
 * any state.
 *
 * @throws {SprintStatusInvalidError} when sprint-status.yaml fails schema validation.
 * @throws {Error} when sprint-status.yaml is missing or unreadable.
 */
export async function getSprintReport(ctx: ToolContext): Promise<SprintReport> {
  const state = await readSprintStatus(ctx.sprintStatusPath);

  const counts = emptyCounts();
  const stories: SprintReportStory[] = [];

  for (const story of state.stories) {
    counts[story.status] += 1;
    const summary: SprintReportStory = {
      id: story.id,
      title: story.title,
      status: story.status,
    };
    if (story.orchestrator?.summary) summary.summary = story.orchestrator.summary;
    if (story.orchestrator?.last_failure_reason) {
      summary.lastFailure = story.orchestrator.last_failure_reason;
    }
    stories.push(summary);
  }

  const rendered = renderReport(state.sprint_id, counts, stories);
  return { counts, stories, rendered };
}
