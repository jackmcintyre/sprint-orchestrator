/**
 * Telemetry logger — the ONLY write path for structured JSONL
 * telemetry events under `<targetRepoRoot>/.crew/telemetry/<YYYY-MM>.jsonl`.
 *
 * Whitelisted in `tests/canonical-fs-guard.test.ts` to import a
 * write-shaped `node:fs` API. Every other code path that wants to
 * record an observable event MUST call `logTelemetryEvent`.
 *
 * **Why `fs.appendFile` rather than `pino.destination()` in v1?**
 * `pino` (^10.3.1) is declared in `package.json` per the architecture
 * (`core-architectural-decisions.md` line 52). Its main appeal is
 * throughput via SonicBoom. This story emits a handful of events per
 * story execution — throughput is not the bottleneck. Using
 * `fs.appendFile` directly:
 *   - keeps the writer synchronous-on-flush (a crash before flush
 *     doesn't lose events),
 *   - sidesteps SonicBoom's worker-thread + buffering semantics,
 *   - keeps the month-rollover code path one function long.
 * A later story can swap to SonicBoom without touching callers; the
 * `pino` dep remains declared so that swap is a writer-only change.
 *
 * No module-level state — no cached handles, no in-memory queue, no
 * rollover registry. Each call resolves the month, ensures the
 * directory, appends, and returns.
 */
import { type TelemetryEvent } from "../schemas/telemetry-events.js";
/**
 * The caller's event minus `ts` — the logger stamps `ts` if absent.
 * If the caller supplies `ts`, the logger validates it as part of the
 * schema check and writes it verbatim (test seam for deterministic
 * round-trips).
 */
export type LogTelemetryEventInput = Omit<TelemetryEvent, "ts"> & {
    ts?: string;
};
export interface LogTelemetryEventOpts {
    targetRepoRoot: string;
    event: LogTelemetryEventInput;
    now?: () => Date;
}
/**
 * Single entrypoint for writing a structured telemetry event. Stamps
 * `ts` if absent, validates the event against its `type`-specific
 * schema, and appends a single JSON-encoded line (terminated by `\n`)
 * to the current month's JSONL file.
 *
 * On Zod failure, the original event is NOT written; a
 * `telemetry.invalid` failure event is written in its place AND a
 * `TelemetryEventInvalidError` is thrown (NFR6).
 */
export declare function logTelemetryEvent(opts: LogTelemetryEventOpts): Promise<void>;
