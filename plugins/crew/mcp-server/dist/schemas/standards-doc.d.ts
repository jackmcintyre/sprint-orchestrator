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
export declare const CriterionSchema: z.ZodObject<{
    name: z.ZodString;
    what: z.ZodString;
    check: z.ZodString;
    anti_criterion: z.ZodString;
}, z.core.$strict>;
export declare const StandardsDocSchema: z.ZodObject<{
    version: z.ZodString;
    updated: z.ZodString;
    criteria: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        what: z.ZodString;
        check: z.ZodString;
        anti_criterion: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type Criterion = z.infer<typeof CriterionSchema>;
/**
 * The on-disk shape (`version`, `updated`, `criteria`) plus the
 * `sourcePath` stamp appended by `lookupStandards` after parsing.
 * `sourcePath` is NOT part of the YAML contract.
 */
export type StandardsDoc = z.infer<typeof StandardsDocSchema> & {
    sourcePath: string;
};
