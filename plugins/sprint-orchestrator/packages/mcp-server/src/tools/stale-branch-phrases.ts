/**
 * Phrase-lock for the stale-branch refusal in `prepareStoryBranch`.
 *
 * Per-story branches from prior failed runs sometimes stick around — either
 * locally (`git branch -a` shows `<id>-<slug>`) or on the remote. Story 3 of
 * the orchestrator-state-and-shipgate sprint (B9 fix) teaches
 * `prepareStoryBranch` to auto-clean *bookkeeping-only* leftovers
 * (`chore(sprint):` and `chore(ship-gate):` commits, which carry no
 * substantive work) but to REFUSE to delete a branch that contains real
 * `feat(<id>):` or `fix(<id>):` commits — those represent unmerged work the
 * human needs to triage by hand.
 *
 * The constant below is the refusal message. It's phrase-locked so the e2e
 * harness and any future skill-prose updates can verify the message stays
 * stable.
 */
export const STALE_BRANCH_HAS_REAL_WORK_REFUSAL =
  "prepareStoryBranch refuses to delete the existing per-story branch: it contains unmerged feat/fix commits. Inspect the branch by hand (`git log <branch>`), merge or discard the work, then re-run.";
