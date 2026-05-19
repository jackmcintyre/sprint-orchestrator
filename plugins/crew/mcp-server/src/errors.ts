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

/**
 * A caller invoked `logTelemetryEvent` with an event whose payload
 * failed its `type`-specific Zod schema. The invalid event was NOT
 * written to the JSONL file; a `telemetry.invalid` failure event was
 * recorded in its place so the failure is never silent (NFR6 / NFR21).
 */
export class TelemetryEventInvalidError extends DomainError {
  readonly attemptedType: string;
  readonly zodPath: string;
  readonly zodMessage: string;

  constructor(opts: { attemptedType: string; zodPath: string; zodMessage: string }) {
    super(
      `Telemetry event of type '${opts.attemptedType}' failed schema validation ` +
        `at '${opts.zodPath}': ${opts.zodMessage}. ` +
        `The invalid event was NOT written; a 'telemetry.invalid' failure event ` +
        `was recorded in its place. (NFR21)`,
    );
    this.attemptedType = opts.attemptedType;
    this.zodPath = opts.zodPath;
    this.zodMessage = opts.zodMessage;
  }
}

/**
 * `gitCommit` refused a call because either the commit message did
 * not match the required `<tool-name>: <ref-or-proposal-id>` shape,
 * or the `paths` set was empty. Thrown BEFORE any subprocess spawn
 * (Story 1.5 AC4).
 */
export class GitCommitMessageMalformedError extends DomainError {
  readonly invalidMessage: string;
  readonly paths: readonly string[];
  readonly reason: string;

  constructor(opts: { message: string; paths: readonly string[]; reason: string }) {
    super(
      `git commit refused: ${opts.reason}. message='${opts.message}', ` +
        `paths=[${opts.paths.join(", ")}]. ` +
        `Required shape: '<tool-name>: <ref-or-proposal-id>' (lowercase tool name, ` +
        `colon, space, non-empty body). (Story 1.5 AC4)`,
    );
    this.invalidMessage = opts.message;
    this.paths = opts.paths;
    this.reason = opts.reason;
  }
}

/**
 * `moveBetweenStates` refused a move because the underlying `fs.rename`
 * returned `EXDEV` — the source and destination resolve to different
 * filesystems. v1 explicitly does NOT fall back to copy+delete because
 * that would create an observable in-between state, violating NFR8's
 * single-syscall atomicity guarantee. (Story 1.6 AC2)
 */
export class CrossFilesystemMoveError extends DomainError {
  readonly absFromPath: string;
  readonly absToPath: string;
  readonly ref: string;
  readonly originalCode: string;

  constructor(opts: {
    absFromPath: string;
    absToPath: string;
    ref: string;
    originalCode: string;
  }) {
    super(
      `Cross-filesystem move refused for manifest '${opts.ref}': ` +
        `fs.rename returned ${opts.originalCode}. ` +
        `from='${opts.absFromPath}', to='${opts.absToPath}'. ` +
        `v1 explicitly does not support cross-filesystem moves ` +
        `(NFR8 — single-syscall atomicity). Place the target repo on a ` +
        `single filesystem, or align the .claude-dev-loop/state/ tree ` +
        `with the repo root. (Story 1.6 AC2)`,
    );
    this.absFromPath = opts.absFromPath;
    this.absToPath = opts.absToPath;
    this.ref = opts.ref;
    this.originalCode = opts.originalCode;
  }
}

/**
 * `moveBetweenStates` was asked to move a manifest from a state
 * directory where the source file does not exist. Maps the underlying
 * `ENOENT` errno from `fs.rename` to a typed domain error. (Story 1.6 AC5)
 */
export class ManifestNotFoundError extends DomainError {
  readonly ref: string;
  readonly expectedAbsPath: string;
  readonly fromState: string;

  constructor(opts: { ref: string; expectedAbsPath: string; fromState: string }) {
    super(
      `Manifest '${opts.ref}' not found at '${opts.expectedAbsPath}' ` +
        `(expected in state '${opts.fromState}'). A move was requested but ` +
        `the source file does not exist. This typically means the manifest ` +
        `was already transitioned by another session, or the ref was never ` +
        `claimed. (Story 1.6 AC5)`,
    );
    this.ref = opts.ref;
    this.expectedAbsPath = opts.expectedAbsPath;
    this.fromState = opts.fromState;
  }
}

/**
 * `moveBetweenStates` refused a transition because either the `from`
 * or `to` state name is not in the canonical whitelist, OR because
 * the resolved absolute path escapes the canonical state-root tree.
 * Thrown BEFORE any filesystem operation. (Story 1.6 AC4)
 */
export class InvalidStateNameError extends DomainError {
  readonly attemptedFrom: string;
  readonly attemptedTo: string;
  readonly allowedStates: readonly string[];
  readonly reason: string;

  constructor(opts: {
    attemptedFrom: string;
    attemptedTo: string;
    allowedStates: readonly string[];
    reason: string;
  }) {
    super(
      `Invalid state-machine transition refused: ${opts.reason}. ` +
        `from='${opts.attemptedFrom}', to='${opts.attemptedTo}'. ` +
        `Allowed states: [${opts.allowedStates.join(", ")}]. (Story 1.6 AC4)`,
    );
    this.attemptedFrom = opts.attemptedFrom;
    this.attemptedTo = opts.attemptedTo;
    this.allowedStates = opts.allowedStates;
    this.reason = opts.reason;
  }
}
