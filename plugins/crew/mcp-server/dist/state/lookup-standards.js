import { promises as fs } from "node:fs";
import * as path from "node:path";
import { StandardsDocMissingError } from "../errors.js";
import { parseStandardsDoc } from "../validators/standards-doc.js";
const COPY_TARGET = "plugins/crew/docs/standards-example.md";
/**
 * Resolve `<targetRepoRoot>/docs/standards.md`, read it, and return the
 * parsed StandardsDoc. Throws StandardsDocMissingError on ENOENT,
 * StandardsDocMalformedError on schema failure (delegated to parser).
 *
 * Single-purpose IO wrapper — no caching, no telemetry, no git, no
 * MCP-tool wrapper. Those layer on in Stories 1.4 (tool), 1.5
 * (telemetry stamping), and Epic 4 (reviewer consumption).
 */
export async function lookupStandards(targetRepoRoot) {
    const sourcePath = path.join(targetRepoRoot, "docs", "standards.md");
    let raw;
    try {
        raw = await fs.readFile(sourcePath, "utf8");
    }
    catch (err) {
        if (err.code === "ENOENT") {
            throw new StandardsDocMissingError({
                expectedPath: sourcePath,
                copyTarget: COPY_TARGET,
            });
        }
        throw err;
    }
    return parseStandardsDoc(raw, sourcePath);
}
