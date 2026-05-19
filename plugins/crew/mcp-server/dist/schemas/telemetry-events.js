import { z } from "zod";
/**
 * Discriminated-union schema for the v1 telemetry event set
 * (Story 1.5 / Implementation-patterns §5 / NFR21 / NFR14).
 *
 * **Closed set in v1.** Adding a new event type means adding a new
 * schema entry plus a `type` literal — no implicit extension. Every
 * payload is `.strict()` so unknown keys are rejected at the boundary.
 * No `data: z.record(...)` escape hatch. No body/diff/contents strings
 * that could leak PII (NFR14).
 *
 * The discriminator is `type`, dotted (`domain.event`). Pinned by
 * Implementation-patterns §5.
 */
/**
 * Fields common to every telemetry event.
 *
 * - `ts`: ISO-8601 UTC timestamp with millisecond precision (Z-suffixed).
 * - `session_id`: opaque caller-supplied identifier (caller's
 *   responsibility to enforce a ULID shape if desired).
 * - `agent`: kebab-cased role name (matches the catalogue convention
 *   and the RolePermissions role regex from Story 1.4).
 * - `story_id`: optional opaque identifier (typically `<adapter>:<source-id>`).
 */
export const TelemetryEventBase = z
    .object({
    ts: z
        .string()
        .datetime({ offset: false })
        .refine((s) => s.endsWith("Z"), "must be UTC"),
    session_id: z.string().min(1),
    agent: z
        .string()
        .min(1)
        .regex(/^[a-z0-9-]+$/),
    story_id: z.string().min(1).optional(),
})
    .strict();
/**
 * `agent.invoke` — per-agent-invocation telemetry (FR65). Carries
 * runtime and (optionally) token counts. No string payloads (NFR14).
 */
export const AgentInvokeEventSchema = TelemetryEventBase.extend({
    type: z.literal("agent.invoke"),
    data: z
        .object({
        runtime_ms: z.number().int().nonnegative(),
        tokens_in: z.number().int().nonnegative().optional(),
        tokens_out: z.number().int().nonnegative().optional(),
    })
        .strict(),
}).strict();
/**
 * `telemetry.invalid` — the failure-recording event emitted by the
 * logger when a caller's event fails its Zod schema (AC2 / NFR6 / FR70).
 * Only carries surfacing fields — never the offending payload (NFR14).
 */
export const TelemetryInvalidEventSchema = TelemetryEventBase.extend({
    type: z.literal("telemetry.invalid"),
    data: z
        .object({
        attempted_type: z.string().min(1),
        zod_path: z.string(),
        zod_message: z.string().min(1),
    })
        .strict(),
}).strict();
export const TelemetryEventSchema = z.discriminatedUnion("type", [
    AgentInvokeEventSchema,
    TelemetryInvalidEventSchema,
]);
