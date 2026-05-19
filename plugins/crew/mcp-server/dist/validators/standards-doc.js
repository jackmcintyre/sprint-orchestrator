import { parse as yamlParse } from "yaml";
import { StandardsDocMalformedError } from "../errors.js";
import { StandardsDocSchema } from "../schemas/standards-doc.js";
const COPY_TARGET = "plugins/crew/docs/standards-example.md";
/**
 * Format a list of Zod issues into a one-line, user-facing string.
 * We surface only the first issue (the most specific). The full list
 * is available on the underlying ZodError if a caller ever needs it.
 */
function formatZodIssues(issues) {
    const first = issues[0];
    if (!first)
        return "(no issue details)";
    const dottedPath = first.path.length > 0 ? first.path.join(".") : "<root>";
    return `${dottedPath}: ${first.message}`;
}
/**
 * Detect the FR46 cap-violation case so we can surface the explicit,
 * AC-pinned wording instead of Zod's generic array-too-big message.
 *
 * The shape: a `too_big` issue on the `criteria` array at root level,
 * with `maximum === 10`.
 */
function isCriteriaCapViolation(issue) {
    if (issue.code !== "too_big")
        return false;
    if (issue.path.length === 0 || issue.path[0] !== "criteria")
        return false;
    // Zod 3.x / 4.x both expose the cap as `.maximum` on too_big issues.
    const maximum = issue.maximum;
    return maximum === 10;
}
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
export function parseStandardsDoc(raw, sourcePath) {
    let parsedYaml;
    try {
        parsedYaml = yamlParse(raw);
    }
    catch (err) {
        throw new StandardsDocMalformedError({
            sourcePath,
            zodMessage: err instanceof Error ? err.message : String(err),
            copyTarget: COPY_TARGET,
        });
    }
    const parsed = StandardsDocSchema.safeParse(parsedYaml);
    if (!parsed.success) {
        const first = parsed.error.issues[0];
        let zodMessage;
        if (isCriteriaCapViolation(first)) {
            const actual = Array.isArray(parsedYaml?.criteria)
                ? parsedYaml.criteria.length
                : "unknown";
            zodMessage = `criteria.length=${actual} exceeds hard cap of 10 (FR46)`;
        }
        else {
            zodMessage = formatZodIssues(parsed.error.issues);
        }
        throw new StandardsDocMalformedError({
            sourcePath,
            zodMessage,
            copyTarget: COPY_TARGET,
        });
    }
    return { ...parsed.data, sourcePath };
}
