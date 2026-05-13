/**
 * Locked phrases the README's "Running a sprint" section must contain
 * verbatim. The e2e harness asserts on these constants directly so the
 * docs prose and the asserted contract are the same string by
 * construction (same discipline as `readme-adopt-phrases.ts` and
 * `readme-runsprint-phrases.ts`).
 *
 * adapt-bmad sprint, story 3 — README documents the adapt-bmad fast
 * path and the BMad-side Verification section convention that BMad
 * story authors must follow for the adaptor to work.
 */

/**
 * Intro sentence positioning adapt-bmad as the first concrete adaptor
 * shipped under the documented adaptor-pattern slot, and stating when
 * to reach for it instead of universal /adopt.
 *
 * Must appear verbatim in the "Running a sprint" section.
 */
export const ADAPT_BMAD_INTRO =
  "`/sprint-orchestrator:adapt-bmad` is the first concrete adaptor shipped under this pattern: a deterministic, instant fast path for BMad-authored stories. Reach for it when your stories were authored by BMad; reach for universal `/sprint-orchestrator:adopt` for any other source.";

/**
 * Statement locking the BMad-side authoring responsibility: every BMad
 * story file must include a `## Verification` section with a fenced
 * shell block, and the adaptor refuses cleanly when the section is
 * missing — there is no silent fallback.
 *
 * Must appear verbatim in the "Running a sprint" section.
 */
export const VERIFICATION_REQUIREMENT_STATEMENT =
  "The convention is a BMad-side authoring responsibility: every BMad story file must include a `## Verification` section containing at least one fenced `shell` block. When the section is missing or empty, `adapt-bmad` refuses the run with a named error — there is no silent fallback.";

/**
 * Concrete example of the BMad-side Verification section, included as
 * a literal substring (fenced shell block intact). Must appear verbatim
 * in the "Running a sprint" section so authors can copy-paste it into
 * a new story file.
 */
export const VERIFICATION_SECTION_EXAMPLE = `\`\`\`shell
pnpm --dir plugins/sprint-orchestrator test -- story-one
\`\`\``;
