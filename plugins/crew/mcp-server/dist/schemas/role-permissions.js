import { z } from "zod";
/**
 * Per-role permission spec shape (FR79–FR81, NFR12, NFR16, NFR17).
 *
 * Authored as YAML under `plugins/crew/permissions/<role>.yaml`. The
 * dispatcher (Story 1.4) refuses any MCP tool invocation whose name
 * is not in `tools_allow`; the `gh` wrapper refuses any subcommand
 * not in `gh_allow`.
 *
 * `.strict()` rejects unknown keys at every level — a typo such as
 * `tool_allow` (singular) must fail loudly, not silently.
 *
 * `tools_allow.min(1)` — a role with zero allowed tools is meaningless,
 * almost certainly a typo.
 *
 * `gh_allow` defaults to `[]` (some roles never touch GitHub).
 *
 * `gh_allow_args` is reserved for forward-compat with Story 2.x / Epic
 * 3 (placeholder substitution). The v1 wrapper applies exact-string
 * matching only; shipped specs leave it empty.
 *
 * `role` regex enforces kebab-case (Implementation-patterns-consistency
 * -rules.md §3) — same convention as the catalogue's `role:` field.
 */
export const RolePermissionsSchema = z
    .object({
    role: z
        .string()
        .min(1)
        .regex(/^[a-z0-9-]+$/),
    tools_allow: z.array(z.string().min(1)).min(1),
    gh_allow: z.array(z.string().min(1)).default([]),
    gh_allow_args: z.record(z.string(), z.array(z.string().min(1))).default({}),
})
    .strict();
