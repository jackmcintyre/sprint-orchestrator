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
