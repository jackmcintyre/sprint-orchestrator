import { z } from "zod";
/**
 * `docs/standards.md` schema — the externalised reviewer rubric the
 * plugin reads on every reviewer verdict (Epic 4) and every retro
 * (Epic 6). Each criterion is a `name` + the three "judge-this"
 * fields (`what`, `check`, `anti_criterion`).
 *
 * `.strict()` rejects unknown keys at every level — the standards
 * doc is a tight contract; surprise keys are bugs.
 *
 * The `.max(10)` cap on `criteria` is load-bearing (FR46) — the
 * parser surfaces a typed error citing the cap when violated. Do
 * not relax.
 */
export const CriterionSchema = z
    .object({
    name: z.string().min(1),
    what: z.string().min(1),
    check: z.string().min(1),
    anti_criterion: z.string().min(1),
})
    .strict();
export const StandardsDocSchema = z
    .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    updated: z.string().min(1),
    criteria: z.array(CriterionSchema).min(1).max(10),
})
    .strict();
