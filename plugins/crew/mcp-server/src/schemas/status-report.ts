import { z } from "zod";
import { SEMVER_REGEX } from "./plugin-manifest.js";

/**
 * Re-export so `StatusReport` consumers and tests can pull the single
 * source of truth for the semver regex without reaching into the
 * manifest module.
 */
export { SEMVER_REGEX };

/** Crockford-base32 ULID — 26 chars, alphabet `0-9A-HJKMNP-TV-Z`. */
const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Typed return shape of the `getStatus` MCP tool (Story 1.7).
 *
 * Every field is required at parse time — no `.default()`, no
 * `.optional()`. The schema is the wire-contract for the `/<plugin>:status`
 * skill and the README install path; partial reports must never leak out
 * of the tool. `renderStatus(report)` consumes this shape unchanged.
 */
export const StatusReportSchema = z.object({
  pluginVersion: z.string().regex(SEMVER_REGEX),
  targetRepoRoot: z.string().min(1),
  adapter: z.discriminatedUnion("state", [
    z.object({ state: z.literal("ok"), name: z.string().min(1) }),
    z.object({
      state: z.literal("mismatched"),
      name: z.string().min(1),
      otherMatchingAdapters: z.array(z.string()),
    }),
  ]),
  standards: z.discriminatedUnion("state", [
    z.object({ state: z.literal("ok"), path: z.string().min(1) }),
    z.object({ state: z.literal("missing"), path: z.string().min(1) }),
    z.object({
      state: z.literal("malformed"),
      path: z.string().min(1),
      zodMessage: z.string().min(1),
    }),
  ]),
  cycle: z.union([z.literal("none"), z.string().regex(ULID_REGEX)]),
});

export type StatusReport = z.infer<typeof StatusReportSchema>;
