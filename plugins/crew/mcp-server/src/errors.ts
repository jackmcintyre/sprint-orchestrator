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

/**
 * `docs/standards.md` was not found at the expected path under the target
 * repo. User must copy the shipped example to bootstrap. Distinct from
 * StandardsDocMalformedError (file exists but fails the schema).
 */
export class StandardsDocMissingError extends DomainError {
  readonly expectedPath: string;
  readonly copyTarget: string;

  constructor(opts: { expectedPath: string; copyTarget: string }) {
    super(
      `docs/standards.md not found at ${opts.expectedPath}. ` +
        `Copy the shipped template from ${opts.copyTarget} to ` +
        `<target-repo>/docs/standards.md and edit for your project. (FR45)`,
    );
    this.expectedPath = opts.expectedPath;
    this.copyTarget = opts.copyTarget;
  }
}

/**
 * `docs/standards.md` was found but failed the parser: either YAML syntax
 * is invalid, a required field is missing or wrongly typed, or the
 * 10-criterion hard cap (FR46) is exceeded. The `zodMessage` field carries
 * the formatted Zod error (or the explicit cap-violation message). The
 * user-facing `message` cites the offending field or the cap.
 */
export class StandardsDocMalformedError extends DomainError {
  readonly sourcePath: string;
  readonly zodMessage: string;
  readonly copyTarget: string;

  constructor(opts: { sourcePath: string; zodMessage: string; copyTarget: string }) {
    super(
      `docs/standards.md at ${opts.sourcePath} is malformed: ${opts.zodMessage}. ` +
        `See the canonical shape in ${opts.copyTarget}. (FR46)`,
    );
    this.sourcePath = opts.sourcePath;
    this.zodMessage = opts.zodMessage;
    this.copyTarget = opts.copyTarget;
  }
}

/**
 * An agent operating under a known role attempted to invoke an MCP tool
 * whose name is not in the role's tools_allow. Caught at the
 * CallToolRequestSchema handler before the tool's handler runs.
 */
export class PermissionDeniedError extends DomainError {
  readonly role: string;
  readonly attemptedTool: string;
  readonly allowedTools: readonly string[];
  readonly specPath: string;

  constructor(opts: {
    role: string;
    attemptedTool: string;
    allowedTools: readonly string[];
    specPath: string;
  }) {
    super(
      `Role '${opts.role}' is not allowed to invoke tool '${opts.attemptedTool}'. ` +
        `Allowed tools for this role: [${opts.allowedTools.join(", ")}]. ` +
        `Edit ${opts.specPath} to grant this capability through PR review (NFR13). ` +
        `(FR79/FR80/NFR12)`,
    );
    this.role = opts.role;
    this.attemptedTool = opts.attemptedTool;
    this.allowedTools = opts.allowedTools;
    this.specPath = opts.specPath;
  }
}

/**
 * An agent operating under a known role attempted to invoke a gh
 * subcommand not in the role's gh_allow. Caught at the gh() wrapper
 * before any subprocess is spawned.
 */
export class GhSubcommandDeniedError extends DomainError {
  readonly role: string;
  readonly attemptedSubcommand: string;
  readonly allowedSubcommands: readonly string[];
  readonly specPath: string;

  constructor(opts: {
    role: string;
    attemptedSubcommand: string;
    allowedSubcommands: readonly string[];
    specPath: string;
  }) {
    super(
      `Role '${opts.role}' is not allowed to invoke 'gh ${opts.attemptedSubcommand}'. ` +
        `Allowed gh subcommands: [${opts.allowedSubcommands.join(", ")}]. ` +
        `Edit ${opts.specPath} to grant this subcommand. (NFR17)`,
    );
    this.role = opts.role;
    this.attemptedSubcommand = opts.attemptedSubcommand;
    this.allowedSubcommands = opts.allowedSubcommands;
    this.specPath = opts.specPath;
  }
}

/**
 * A code path attempted to write to a canonical-state path under the
 * target repo without an MCP tool context. Routes through
 * writeManagedFile() are the only permitted entrypoint, and they
 * require an explicit { toolName, role } context.
 */
export class CanonicalFsWriteError extends DomainError {
  readonly attemptedPath: string;
  readonly canonicalPathGlob: string;

  constructor(opts: { attemptedPath: string; canonicalPathGlob: string }) {
    super(
      `Write to canonical-state path '${opts.attemptedPath}' ` +
        `(matches '${opts.canonicalPathGlob}') is not permitted outside an MCP tool. ` +
        `Route this write through an MCP tool that calls writeManagedFile(...). ` +
        `(FR81/NFR16)`,
    );
    this.attemptedPath = opts.attemptedPath;
    this.canonicalPathGlob = opts.canonicalPathGlob;
  }
}

/**
 * Permission spec file for the named role does not exist at the
 * expected path. Distinct from RolePermissionsMalformedError (file
 * exists but fails the schema).
 */
export class RolePermissionsMissingError extends DomainError {
  readonly role: string;
  readonly specPath: string;

  constructor(opts: { role: string; specPath: string }) {
    super(
      `Permission spec for role '${opts.role}' not found at ${opts.specPath}. ` +
        `See the canonical example in plugins/crew/permissions/generalist-dev.yaml.`,
    );
    this.role = opts.role;
    this.specPath = opts.specPath;
  }
}

/**
 * Permission spec file exists but failed the parser (YAML syntax,
 * missing required field, or unknown key).
 */
export class RolePermissionsMalformedError extends DomainError {
  readonly specPath: string;
  readonly zodMessage: string;

  constructor(opts: { specPath: string; zodMessage: string }) {
    super(
      `Permission spec at ${opts.specPath} is malformed: ${opts.zodMessage}. ` +
        `See the canonical example in plugins/crew/permissions/generalist-dev.yaml.`,
    );
    this.specPath = opts.specPath;
    this.zodMessage = opts.zodMessage;
  }
}
