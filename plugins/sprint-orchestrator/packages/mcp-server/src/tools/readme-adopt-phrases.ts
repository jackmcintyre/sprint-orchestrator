/**
 * Locked phrases the README's "Running a sprint" section must contain
 * verbatim. The e2e harness asserts on these constants directly so the
 * docs-build and the asserted contract are the same string by
 * construction (same discipline as `format-end-of-run-line.ts`).
 *
 * Story 1.3 — README documents adopt as recommended entrypoint and
 * names the in-plugin adaptor pattern.
 */

/**
 * The recommended entrypoint for bringing an externally-authored backlog
 * into the orchestrator. Must appear in the "Running a sprint" section.
 */
export const ADOPT_COMMAND = "/sprint-orchestrator:adopt";

/**
 * The in-plugin extension-point phrase. README must name this pattern
 * explicitly so users searching for "how do I plug producer X in?" land
 * on the right concept.
 */
export const ADAPTOR_PATTERN_PHRASE = "adaptor pattern";

/**
 * One-way-coupling rule, in prose. The orchestrator core does not
 * import adaptors; adaptors depend on the schema, never the reverse.
 * This is the FR6/NFR1 contract from the epics doc, in plain English.
 *
 * Must appear verbatim in the README so e2e and prose cannot drift.
 */
export const ONE_WAY_COUPLING_STATEMENT =
  "The orchestrator core does not import adaptors; adaptors depend on the schema, not the other way round.";

/**
 * Framing for citing BMad (or any future producer) as an example, not
 * as a canonical integration. The README must use this exact phrasing
 * so no producer ends up looking privileged.
 */
export const PRODUCER_EXAMPLE_FRAMING =
  "BMad is one example; the pattern works for any producer that can emit a conforming backlog.";

/**
 * Sprint-scope disclaimer: pattern is documented for future extension,
 * no adaptors ship in this sprint. Keeps reader expectations aligned
 * with what's actually on disk.
 */
export const NO_ADAPTORS_SHIP_STATEMENT =
  "No adaptors ship in this sprint; the pattern is documented for future extension.";
