import { z } from "zod";

export const StoryStatus = z.enum(["backlog", "ready", "in_progress", "done", "failed", "blocked"]);
export type StoryStatus = z.infer<typeof StoryStatus>;

export const ShellCheck = z.object({
  type: z.literal("shell"),
  cmd: z.string().min(1),
  expect_exit: z.number().int().default(0),
});

export const FileExistsCheck = z.object({
  type: z.literal("file_exists"),
  path: z.string().min(1),
});

export const RegexCheck = z.object({
  type: z.literal("regex"),
  cmd: z.string().min(1),
  pattern: z.string().min(1),
});

export const Check = z.discriminatedUnion("type", [ShellCheck, FileExistsCheck, RegexCheck]);
export type Check = z.infer<typeof Check>;

export const AcceptanceCriteria = z
  .object({
    checks: z.array(Check).default([]),
  })
  .default({ checks: [] });

export const FailureDetailSchema = z
  .object({
    cmd: z.string(),
    exit_code: z.number().int(),
    expected_exit: z.number().int(),
    stderr: z.string(),
    stdout: z.string(),
    recorded_at: z.string().datetime({ offset: true }),
  })
  .passthrough();
export type FailureDetail = z.infer<typeof FailureDetailSchema>;

export const OrchestratorMeta = z
  .object({
    claimed_by: z.string().optional(),
    claimed_at: z.string().datetime({ offset: true }).optional(),
    completed_at: z.string().datetime({ offset: true }).optional(),
    summary: z.string().optional(),
    last_failure_reason: z.string().optional(),
    rework_count: z.number().int().nonnegative().default(0),
    last_review_feedback: z.string().optional(),
    last_review_at: z.string().datetime({ offset: true }).optional(),
    /**
     * Branch ref this story's per-story branch was rooted from. Populated by
     * `prepareStoryBranch` whenever it creates a branch — usually
     * `default_base`, but when the story's `depends_on` includes already-done
     * stories with their own per-story branches still on disk, this records
     * the predecessor's branch tip we rooted from instead.
     */
    base_branch: z.string().optional(),
    /**
     * Reason `prepareStoryBranch` fell back to `default_base` instead of
     * rooting from a dependency's branch tip. Only set when `depends_on` was
     * non-empty AND we could not chain (e.g. a dep lacks `orchestrator.branch`,
     * or its branch no longer exists locally).
     */
    base_branch_fallback_reason: z.string().optional(),
    /**
     * When `recordStoryReopen` transitions a story from `failed` back to
     * `ready`, it appends an entry here capturing the prior failure reason +
     * the reopen reason so the audit trail survives the reset. Never cleared
     * once written.
     */
    reopen_history: z
      .array(
        z
          .object({
            reopened_at: z.string().datetime({ offset: true }),
            reason: z.string().min(1),
            prior_status: z.literal("failed"),
            prior_failure_reason: z.string().optional(),
            /** Agent or user identifier that called recordStoryReopen. Optional — omitted when the caller is anonymous. */
            reopened_by_agent_id: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    /** Timestamp of the last failure. Cleared by `recordStoryReopen`. */
    failed_at: z.string().datetime({ offset: true }).optional(),
    /**
     * Per-failed-check structured details captured by `recordStoryFailure`.
     * Each entry corresponds to one check that did not pass. Cleared by
     * `recordStoryReopen` alongside `failed_at` and `last_failure_reason`.
     */
    failure_details: z.array(FailureDetailSchema).optional(),
    /**
     * ISO timestamp written by `markDevReturned` when the dev subagent
     * finishes its implementation swing. `recordStoryFailure` and
     * `validateAcceptanceCriteria` refuse when this is absent, preventing
     * the reviewer from evaluating ACs before any dev work has happened.
     * Cleared by `recordStoryReopen` alongside other failure fields.
     */
    dev_returned_at: z.string().datetime({ offset: true }).optional(),
  })
  .passthrough()
  .default({});

export const Story = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: StoryStatus,
    depends_on: z.array(z.string()).default([]),
    acceptance_criteria: AcceptanceCriteria,
    orchestrator: OrchestratorMeta,
  })
  .passthrough();
export type Story = z.infer<typeof Story>;

/**
 * Schema version the running MCP server expects to find in
 * `sprint-status.yaml`. Bump when the on-disk shape changes in a way the
 * server depends on; `prepareStoryBranch` reads the `default_base`'s
 * sprint-status and refuses to create a per-story branch when its
 * `schema_version` does not match this constant (see
 * prepare-story-branch.ts for the rationale).
 */
export const SCHEMA_VERSION = 1;

export const SprintStatus = z
  .object({
    sprint_id: z.string().min(1),
    schema_version: z.number().int().optional(),
    stories: z.array(Story),
  })
  .passthrough();
export type SprintStatus = z.infer<typeof SprintStatus>;
