/**
 * Typed error hierarchy for the crew plugin.
 *
 * All domain errors extend `DomainError`. The MCP boundary
 * (tool handlers in later stories) maps these to MCP errors.
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Preserve V8 stack frames if available.
    if (typeof (Error as unknown as { captureStackTrace?: unknown }).captureStackTrace === "function") {
      (Error as unknown as { captureStackTrace: (t: object, c?: object) => void }).captureStackTrace(this, new.target);
    }
  }
}

/**
 * Thrown when a method or seam exists for future stories but has
 * no behavior yet. Always include the story reference that will
 * land the real implementation.
 */
export class NotImplementedError extends DomainError {}

/**
 * `.claude-dev-loop/config.yaml` exists but failed schema validation
 * (malformed YAML, missing required keys, wrong types, unknown adapter
 * name, or invalid adapter_config). User must fix the file by hand —
 * the resolver does NOT fall back to `detect()`.
 */
export class InvalidWorkspaceConfigError extends DomainError {
  readonly configPath: string;
  readonly yamlPath: string;
  readonly zodMessage: string;
  readonly schemaModule: string;

  constructor(opts: {
    configPath: string;
    yamlPath: string;
    zodMessage: string;
    schemaModule: string;
  }) {
    super(
      `${opts.configPath} is invalid at '${opts.yamlPath}': ${opts.zodMessage}. ` +
        `See ${opts.schemaModule} and the canonical example in ` +
        `plugins/crew/example/.claude-dev-loop/config.yaml.`,
    );
    this.configPath = opts.configPath;
    this.yamlPath = opts.yamlPath;
    this.zodMessage = opts.zodMessage;
    this.schemaModule = opts.schemaModule;
  }
}

/**
 * No registered adapter's `detect()` returned true for the target repo.
 * User must author `.claude-dev-loop/config.yaml` manually.
 */
export class NoAdapterMatchedError extends DomainError {
  readonly targetRepoRoot: string;
  readonly registeredAdapters: string[];

  constructor(opts: { targetRepoRoot: string; registeredAdapters: string[] }) {
    super(
      `No registered adapter recognises ${opts.targetRepoRoot}. ` +
        `Registered adapters: [${opts.registeredAdapters.join(", ")}]. ` +
        `Author .claude-dev-loop/config.yaml manually following ` +
        `plugins/crew/example/.claude-dev-loop/config.yaml.`,
    );
    this.targetRepoRoot = opts.targetRepoRoot;
    this.registeredAdapters = opts.registeredAdapters;
  }
}

/**
 * Two or more registered adapters' `detect()` returned true for the
 * target repo. User must disambiguate by authoring config manually.
 */
export class AmbiguousAdapterError extends DomainError {
  readonly targetRepoRoot: string;
  readonly matchingAdapters: string[];

  constructor(opts: { targetRepoRoot: string; matchingAdapters: string[] }) {
    super(
      `Multiple adapters recognise ${opts.targetRepoRoot}: ` +
        `[${opts.matchingAdapters.join(", ")}]. ` +
        `Author .claude-dev-loop/config.yaml manually to pick one.`,
    );
    this.targetRepoRoot = opts.targetRepoRoot;
    this.matchingAdapters = opts.matchingAdapters;
  }
}

/**
 * The configured adapter's detect() returned false for the target repo.
 * The config parsed cleanly — it is just no longer (or never was) a match
 * for this repo. Typical cause: user copied example config into a repo
 * that doesn't fit. Distinct from InvalidWorkspaceConfigError (schema fail)
 * and NoAdapterMatchedError (no config + no detect match).
 */
export class StaleWorkspaceConfigError extends DomainError {
  readonly targetRepoRoot: string;
  readonly configuredAdapter: string;
  readonly otherMatchingAdapters: string[];
  readonly schemaModule: string;

  constructor(opts: {
    targetRepoRoot: string;
    configuredAdapter: string;
    otherMatchingAdapters: string[];
    schemaModule: string;
  }) {
    const redirect =
      opts.otherMatchingAdapters.length > 0
        ? `Other registered adapters that recognise this repo: ` +
          `[${opts.otherMatchingAdapters.join(", ")}]. ` +
          `Update the 'adapter:' key in .claude-dev-loop/config.yaml.`
        : `No other registered adapter recognises this repo either. ` +
          `See ${opts.schemaModule} and the canonical example in ` +
          `plugins/crew/example/.claude-dev-loop/config.yaml.`;
    super(
      `Configured adapter '${opts.configuredAdapter}' returned detect()=false ` +
        `for ${opts.targetRepoRoot}. ${redirect}`,
    );
    this.targetRepoRoot = opts.targetRepoRoot;
    this.configuredAdapter = opts.configuredAdapter;
    this.otherMatchingAdapters = opts.otherMatchingAdapters;
    this.schemaModule = opts.schemaModule;
  }
}
