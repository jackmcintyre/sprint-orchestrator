/**
 * Typed error hierarchy for the crew plugin.
 *
 * All domain errors extend `DomainError`. The MCP boundary
 * (tool handlers in later stories) maps these to MCP errors.
 */
export declare class DomainError extends Error {
    constructor(message: string);
}
/**
 * Thrown when a method or seam exists for future stories but has
 * no behavior yet. Always include the story reference that will
 * land the real implementation.
 */
export declare class NotImplementedError extends DomainError {
}
/**
 * `.crew/config.yaml` exists but failed schema validation
 * (malformed YAML, missing required keys, wrong types, unknown adapter
 * name, or invalid adapter_config). User must fix the file by hand —
 * the resolver does NOT fall back to `detect()`.
 */
export declare class InvalidWorkspaceConfigError extends DomainError {
    readonly configPath: string;
    readonly yamlPath: string;
    readonly zodMessage: string;
    readonly schemaModule: string;
    constructor(opts: {
        configPath: string;
        yamlPath: string;
        zodMessage: string;
        schemaModule: string;
    });
}
/**
 * No registered adapter's `detect()` returned true for the target repo.
 * User must author `.crew/config.yaml` manually.
 */
export declare class NoAdapterMatchedError extends DomainError {
    readonly targetRepoRoot: string;
    readonly registeredAdapters: string[];
    constructor(opts: {
        targetRepoRoot: string;
        registeredAdapters: string[];
    });
}
/**
 * Two or more registered adapters' `detect()` returned true for the
 * target repo. User must disambiguate by authoring config manually.
 */
export declare class AmbiguousAdapterError extends DomainError {
    readonly targetRepoRoot: string;
    readonly matchingAdapters: string[];
    constructor(opts: {
        targetRepoRoot: string;
        matchingAdapters: string[];
    });
}
/**
 * The configured adapter's detect() returned false for the target repo.
 * The config parsed cleanly — it is just no longer (or never was) a match
 * for this repo. Typical cause: user copied example config into a repo
 * that doesn't fit. Distinct from InvalidWorkspaceConfigError (schema fail)
 * and NoAdapterMatchedError (no config + no detect match).
 */
export declare class StaleWorkspaceConfigError extends DomainError {
    readonly targetRepoRoot: string;
    readonly configuredAdapter: string;
    readonly otherMatchingAdapters: string[];
    readonly schemaModule: string;
    constructor(opts: {
        targetRepoRoot: string;
        configuredAdapter: string;
        otherMatchingAdapters: string[];
        schemaModule: string;
    });
}
/**
 * `docs/standards.md` was not found at the expected path under the target
 * repo. User must copy the shipped example to bootstrap. Distinct from
 * StandardsDocMalformedError (file exists but fails the schema).
 */
export declare class StandardsDocMissingError extends DomainError {
    readonly expectedPath: string;
    readonly copyTarget: string;
    constructor(opts: {
        expectedPath: string;
        copyTarget: string;
    });
}
/**
 * `docs/standards.md` was found but failed the parser: either YAML syntax
 * is invalid, a required field is missing or wrongly typed, or the
 * 10-criterion hard cap (FR46) is exceeded. The `zodMessage` field carries
 * the formatted Zod error (or the explicit cap-violation message). The
 * user-facing `message` cites the offending field or the cap.
 */
export declare class StandardsDocMalformedError extends DomainError {
    readonly sourcePath: string;
    readonly zodMessage: string;
    readonly copyTarget: string;
    constructor(opts: {
        sourcePath: string;
        zodMessage: string;
        copyTarget: string;
    });
}
/**
 * An agent operating under a known role attempted to invoke an MCP tool
 * whose name is not in the role's tools_allow. Caught at the
 * CallToolRequestSchema handler before the tool's handler runs.
 */
export declare class PermissionDeniedError extends DomainError {
    readonly role: string;
    readonly attemptedTool: string;
    readonly allowedTools: readonly string[];
    readonly specPath: string;
    constructor(opts: {
        role: string;
        attemptedTool: string;
        allowedTools: readonly string[];
        specPath: string;
    });
}
/**
 * An agent operating under a known role attempted to invoke a gh
 * subcommand not in the role's gh_allow. Caught at the gh() wrapper
 * before any subprocess is spawned.
 */
export declare class GhSubcommandDeniedError extends DomainError {
    readonly role: string;
    readonly attemptedSubcommand: string;
    readonly allowedSubcommands: readonly string[];
    readonly specPath: string;
    constructor(opts: {
        role: string;
        attemptedSubcommand: string;
        allowedSubcommands: readonly string[];
        specPath: string;
    });
}
/**
 * A code path attempted to write to a canonical-state path under the
 * target repo without an MCP tool context. Routes through
 * writeManagedFile() are the only permitted entrypoint, and they
 * require an explicit { toolName, role } context.
 */
export declare class CanonicalFsWriteError extends DomainError {
    readonly attemptedPath: string;
    readonly canonicalPathGlob: string;
    constructor(opts: {
        attemptedPath: string;
        canonicalPathGlob: string;
    });
}
/**
 * Permission spec file for the named role does not exist at the
 * expected path. Distinct from RolePermissionsMalformedError (file
 * exists but fails the schema).
 */
export declare class RolePermissionsMissingError extends DomainError {
    readonly role: string;
    readonly specPath: string;
    constructor(opts: {
        role: string;
        specPath: string;
    });
}
/**
 * Permission spec file exists but failed the parser (YAML syntax,
 * missing required field, or unknown key).
 */
export declare class RolePermissionsMalformedError extends DomainError {
    readonly specPath: string;
    readonly zodMessage: string;
    constructor(opts: {
        specPath: string;
        zodMessage: string;
    });
}
/**
 * A caller invoked `logTelemetryEvent` with an event whose payload
 * failed its `type`-specific Zod schema. The invalid event was NOT
 * written to the JSONL file; a `telemetry.invalid` failure event was
 * recorded in its place so the failure is never silent (NFR6 / NFR21).
 */
export declare class TelemetryEventInvalidError extends DomainError {
    readonly attemptedType: string;
    readonly zodPath: string;
    readonly zodMessage: string;
    constructor(opts: {
        attemptedType: string;
        zodPath: string;
        zodMessage: string;
    });
}
/**
 * `gitCommit` refused a call because either the commit message did
 * not match the required `<tool-name>: <ref-or-proposal-id>` shape,
 * or the `paths` set was empty. Thrown BEFORE any subprocess spawn
 * (Story 1.5 AC4).
 */
export declare class GitCommitMessageMalformedError extends DomainError {
    readonly invalidMessage: string;
    readonly paths: readonly string[];
    readonly reason: string;
    constructor(opts: {
        message: string;
        paths: readonly string[];
        reason: string;
    });
}
/**
 * `moveBetweenStates` refused a move because the underlying `fs.rename`
 * returned `EXDEV` — the source and destination resolve to different
 * filesystems. v1 explicitly does NOT fall back to copy+delete because
 * that would create an observable in-between state, violating NFR8's
 * single-syscall atomicity guarantee. (Story 1.6 AC2)
 */
export declare class CrossFilesystemMoveError extends DomainError {
    readonly absFromPath: string;
    readonly absToPath: string;
    readonly ref: string;
    readonly originalCode: string;
    constructor(opts: {
        absFromPath: string;
        absToPath: string;
        ref: string;
        originalCode: string;
    });
}
/**
 * `moveBetweenStates` was asked to move a manifest from a state
 * directory where the source file does not exist. Maps the underlying
 * `ENOENT` errno from `fs.rename` to a typed domain error. (Story 1.6 AC5)
 */
export declare class ManifestNotFoundError extends DomainError {
    readonly ref: string;
    readonly expectedAbsPath: string;
    readonly fromState: string;
    constructor(opts: {
        ref: string;
        expectedAbsPath: string;
        fromState: string;
    });
}
/**
 * `moveBetweenStates` refused a transition because either the `from`
 * or `to` state name is not in the canonical whitelist, OR because
 * the resolved absolute path escapes the canonical state-root tree.
 * Thrown BEFORE any filesystem operation. (Story 1.6 AC4)
 */
export declare class InvalidStateNameError extends DomainError {
    readonly attemptedFrom: string;
    readonly attemptedTo: string;
    readonly allowedStates: readonly string[];
    readonly reason: string;
    constructor(opts: {
        attemptedFrom: string;
        attemptedTo: string;
        allowedStates: readonly string[];
        reason: string;
    });
}
