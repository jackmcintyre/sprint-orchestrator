import { z } from "zod";
import { SEMVER_REGEX } from "./plugin-manifest.js";
/**
 * Re-export so `StatusReport` consumers and tests can pull the single
 * source of truth for the semver regex without reaching into the
 * manifest module.
 */
export { SEMVER_REGEX };
/**
 * Typed return shape of the `getStatus` MCP tool (Story 1.7).
 *
 * Every field is required at parse time — no `.default()`, no
 * `.optional()`. The schema is the wire-contract for the `/<plugin>:status`
 * skill and the README install path; partial reports must never leak out
 * of the tool. `renderStatus(report)` consumes this shape unchanged.
 */
export declare const StatusReportSchema: z.ZodObject<{
    pluginVersion: z.ZodString;
    targetRepoRoot: z.ZodString;
    adapter: z.ZodDiscriminatedUnion<[z.ZodObject<{
        state: z.ZodLiteral<"ok">;
        name: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        state: z.ZodLiteral<"mismatched">;
        name: z.ZodString;
        otherMatchingAdapters: z.ZodArray<z.ZodString>;
    }, z.core.$strip>], "state">;
    standards: z.ZodDiscriminatedUnion<[z.ZodObject<{
        state: z.ZodLiteral<"ok">;
        path: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        state: z.ZodLiteral<"missing">;
        path: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        state: z.ZodLiteral<"malformed">;
        path: z.ZodString;
        zodMessage: z.ZodString;
    }, z.core.$strip>], "state">;
    cycle: z.ZodUnion<readonly [z.ZodLiteral<"none">, z.ZodString]>;
}, z.core.$strip>;
export type StatusReport = z.infer<typeof StatusReportSchema>;
