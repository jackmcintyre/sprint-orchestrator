import { type StandardsDoc } from "../schemas/standards-doc.js";
/**
 * Parse the contents of a `docs/standards.md` file (a YAML document)
 * into a typed StandardsDoc. Pure — no IO. The caller (`lookupStandards`)
 * supplies `sourcePath` for error reporting and to stamp onto the
 * returned value.
 *
 * Throws StandardsDocMalformedError on YAML-syntax errors, Zod-schema
 * failures, or criterion-count cap violations. The cap violation gets a
 * specially-formatted zodMessage (`criteria.length=<N> exceeds hard cap
 * of 10 (FR46)`) so the user-facing message is unambiguous.
 */
export declare function parseStandardsDoc(raw: string, sourcePath: string): StandardsDoc;
