export class OrchestratorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class StateNotFoundError extends OrchestratorError {
  constructor(path: string) {
    super(`Sprint status file not found at ${path}`, "STATE_NOT_FOUND", { path });
  }
}

export class StateParseError extends OrchestratorError {
  constructor(path: string, cause: unknown) {
    super(
      `Failed to parse sprint status at ${path}: ${(cause as Error)?.message ?? cause}`,
      "STATE_PARSE",
      { path },
    );
  }
}

export class LockTimeoutError extends OrchestratorError {
  constructor(path: string) {
    super(`Could not acquire lock on ${path} after retries`, "LOCK_TIMEOUT", { path });
  }
}

export class StoryNotFoundError extends OrchestratorError {
  constructor(storyId: string) {
    super(`Story ${storyId} not found`, "STORY_NOT_FOUND", { storyId });
  }
}

export class ClaimConflictError extends OrchestratorError {
  constructor(storyId: string, expectedHolder: string, actualHolder: string | undefined) {
    super(
      `Story ${storyId} not claimed by ${expectedHolder} (held by ${actualHolder ?? "no one"})`,
      "CLAIM_CONFLICT",
      { storyId, expectedHolder, actualHolder },
    );
  }
}

export class InvalidStateTransitionError extends OrchestratorError {
  constructor(storyId: string, from: string, to: string) {
    super(`Cannot transition story ${storyId} from ${from} to ${to}`, "INVALID_TRANSITION", {
      storyId,
      from,
      to,
    });
  }
}

export class AcceptanceFailedError extends OrchestratorError {
  constructor(storyId: string, failures: unknown[]) {
    super(`Acceptance criteria failed for ${storyId}`, "ACCEPTANCE_FAILED", { storyId, failures });
  }
}
