/**
 * Typed error hierarchy for the crew plugin.
 *
 * All domain errors extend `DomainError`. The MCP boundary
 * (tool handlers in later stories) maps these to MCP errors.
 */
export class DomainError extends Error {
    constructor(message) {
        super(message);
        this.name = new.target.name;
        // Preserve V8 stack frames if available.
        if (typeof Error.captureStackTrace === "function") {
            Error.captureStackTrace(this, new.target);
        }
    }
}
/**
 * Thrown when a method or seam exists for future stories but has
 * no behavior yet. Always include the story reference that will
 * land the real implementation.
 */
export class NotImplementedError extends DomainError {
}
/**
 * `.crew/config.yaml` exists but failed schema validation
 * (malformed YAML, missing required keys, wrong types, unknown adapter
 * name, or invalid adapter_config). User must fix the file by hand —
 * the resolver does NOT fall back to `detect()`.
 */
export class InvalidWorkspaceConfigError extends DomainError {
    configPath;
    yamlPath;
    zodMessage;
    schemaModule;
    constructor(opts) {
        super(`${opts.configPath} is invalid at '${opts.yamlPath}': ${opts.zodMessage}. ` +
            `See ${opts.schemaModule} and the canonical example in ` +
            `plugins/crew/example/.crew/config.yaml.`);
        this.configPath = opts.configPath;
        this.yamlPath = opts.yamlPath;
        this.zodMessage = opts.zodMessage;
        this.schemaModule = opts.schemaModule;
    }
}
/**
 * No registered adapter's `detect()` returned true for the target repo.
 * User must author `.crew/config.yaml` manually.
 */
export class NoAdapterMatchedError extends DomainError {
    targetRepoRoot;
    registeredAdapters;
    constructor(opts) {
        super(`No registered adapter recognises ${opts.targetRepoRoot}. ` +
            `Registered adapters: [${opts.registeredAdapters.join(", ")}]. ` +
            `Author .crew/config.yaml manually following ` +
            `plugins/crew/example/.crew/config.yaml.`);
        this.targetRepoRoot = opts.targetRepoRoot;
        this.registeredAdapters = opts.registeredAdapters;
    }
}
/**
 * Two or more registered adapters' `detect()` returned true for the
 * target repo. User must disambiguate by authoring config manually.
 */
export class AmbiguousAdapterError extends DomainError {
    targetRepoRoot;
    matchingAdapters;
    constructor(opts) {
        super(`Multiple adapters recognise ${opts.targetRepoRoot}: ` +
            `[${opts.matchingAdapters.join(", ")}]. ` +
            `Author .crew/config.yaml manually to pick one.`);
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
    targetRepoRoot;
    configuredAdapter;
    otherMatchingAdapters;
    schemaModule;
    constructor(opts) {
        const redirect = opts.otherMatchingAdapters.length > 0
            ? `Other registered adapters that recognise this repo: ` +
                `[${opts.otherMatchingAdapters.join(", ")}]. ` +
                `Update the 'adapter:' key in .crew/config.yaml.`
            : `No other registered adapter recognises this repo either. ` +
                `See ${opts.schemaModule} and the canonical example in ` +
                `plugins/crew/example/.crew/config.yaml.`;
        super(`Configured adapter '${opts.configuredAdapter}' returned detect()=false ` +
            `for ${opts.targetRepoRoot}. ${redirect}`);
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
    expectedPath;
    copyTarget;
    constructor(opts) {
        super(`docs/standards.md not found at ${opts.expectedPath}. ` +
            `Copy the shipped template from ${opts.copyTarget} to ` +
            `<target-repo>/docs/standards.md and edit for your project. (FR45)`);
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
    sourcePath;
    zodMessage;
    copyTarget;
    constructor(opts) {
        super(`docs/standards.md at ${opts.sourcePath} is malformed: ${opts.zodMessage}. ` +
            `See the canonical shape in ${opts.copyTarget}. (FR46)`);
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
    role;
    attemptedTool;
    allowedTools;
    specPath;
    constructor(opts) {
        super(`Role '${opts.role}' is not allowed to invoke tool '${opts.attemptedTool}'. ` +
            `Allowed tools for this role: [${opts.allowedTools.join(", ")}]. ` +
            `Edit ${opts.specPath} to grant this capability through PR review (NFR13). ` +
            `(FR79/FR80/NFR12)`);
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
    role;
    attemptedSubcommand;
    allowedSubcommands;
    specPath;
    constructor(opts) {
        super(`Role '${opts.role}' is not allowed to invoke 'gh ${opts.attemptedSubcommand}'. ` +
            `Allowed gh subcommands: [${opts.allowedSubcommands.join(", ")}]. ` +
            `Edit ${opts.specPath} to grant this subcommand. (NFR17)`);
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
    attemptedPath;
    canonicalPathGlob;
    constructor(opts) {
        super(`Write to canonical-state path '${opts.attemptedPath}' ` +
            `(matches '${opts.canonicalPathGlob}') is not permitted outside an MCP tool. ` +
            `Route this write through an MCP tool that calls writeManagedFile(...). ` +
            `(FR81/NFR16)`);
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
    role;
    specPath;
    constructor(opts) {
        super(`Permission spec for role '${opts.role}' not found at ${opts.specPath}. ` +
            `See the canonical example in plugins/crew/permissions/generalist-dev.yaml.`);
        this.role = opts.role;
        this.specPath = opts.specPath;
    }
}
/**
 * Permission spec file exists but failed the parser (YAML syntax,
 * missing required field, or unknown key).
 */
export class RolePermissionsMalformedError extends DomainError {
    specPath;
    zodMessage;
    constructor(opts) {
        super(`Permission spec at ${opts.specPath} is malformed: ${opts.zodMessage}. ` +
            `See the canonical example in plugins/crew/permissions/generalist-dev.yaml.`);
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
    attemptedType;
    zodPath;
    zodMessage;
    constructor(opts) {
        super(`Telemetry event of type '${opts.attemptedType}' failed schema validation ` +
            `at '${opts.zodPath}': ${opts.zodMessage}. ` +
            `The invalid event was NOT written; a 'telemetry.invalid' failure event ` +
            `was recorded in its place. (NFR21)`);
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
    invalidMessage;
    paths;
    reason;
    constructor(opts) {
        super(`git commit refused: ${opts.reason}. message='${opts.message}', ` +
            `paths=[${opts.paths.join(", ")}]. ` +
            `Required shape: '<tool-name>: <ref-or-proposal-id>' (lowercase tool name, ` +
            `colon, space, non-empty body). (Story 1.5 AC4)`);
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
    absFromPath;
    absToPath;
    ref;
    originalCode;
    constructor(opts) {
        super(`Cross-filesystem move refused for manifest '${opts.ref}': ` +
            `fs.rename returned ${opts.originalCode}. ` +
            `from='${opts.absFromPath}', to='${opts.absToPath}'. ` +
            `v1 explicitly does not support cross-filesystem moves ` +
            `(NFR8 — single-syscall atomicity). Place the target repo on a ` +
            `single filesystem, or align the .crew/state/ tree ` +
            `with the repo root. (Story 1.6 AC2)`);
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
    ref;
    expectedAbsPath;
    fromState;
    constructor(opts) {
        super(`Manifest '${opts.ref}' not found at '${opts.expectedAbsPath}' ` +
            `(expected in state '${opts.fromState}'). A move was requested but ` +
            `the source file does not exist. This typically means the manifest ` +
            `was already transitioned by another session, or the ref was never ` +
            `claimed. (Story 1.6 AC5)`);
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
    attemptedFrom;
    attemptedTo;
    allowedStates;
    reason;
    constructor(opts) {
        super(`Invalid state-machine transition refused: ${opts.reason}. ` +
            `from='${opts.attemptedFrom}', to='${opts.attemptedTo}'. ` +
            `Allowed states: [${opts.allowedStates.join(", ")}]. (Story 1.6 AC4)`);
        this.attemptedFrom = opts.attemptedFrom;
        this.attemptedTo = opts.attemptedTo;
        this.allowedStates = opts.allowedStates;
        this.reason = opts.reason;
    }
}
