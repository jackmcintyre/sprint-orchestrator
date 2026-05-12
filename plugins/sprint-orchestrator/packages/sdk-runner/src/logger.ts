/**
 * Structured JSON to stdout (one line per event). Human-readable lines to
 * stderr. Tests can stub `streams` to capture both.
 */
export interface Streams {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
}

export const defaultStreams: Streams = { out: process.stdout, err: process.stderr };

export function emit(streams: Streams, event: Record<string, unknown>): void {
  streams.out.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

export function log(streams: Streams, msg: string): void {
  streams.err.write(`[sprint-orchestrator] ${msg}\n`);
}
