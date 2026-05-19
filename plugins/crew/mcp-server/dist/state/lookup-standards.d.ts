import type { StandardsDoc } from "../schemas/standards-doc.js";
/**
 * Resolve `<targetRepoRoot>/docs/standards.md`, read it, and return the
 * parsed StandardsDoc. Throws StandardsDocMissingError on ENOENT,
 * StandardsDocMalformedError on schema failure (delegated to parser).
 *
 * Single-purpose IO wrapper — no caching, no telemetry, no git, no
 * MCP-tool wrapper. Those layer on in Stories 1.4 (tool), 1.5
 * (telemetry stamping), and Epic 4 (reviewer consumption).
 */
export declare function lookupStandards(targetRepoRoot: string): Promise<StandardsDoc>;
