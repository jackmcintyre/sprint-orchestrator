/**
 * Read stdin to completion and parse as JSON. Resolves to `null` if stdin
 * is empty (Claude Code may invoke hooks with no payload in some events).
 */
export async function readStdinJson<T = unknown>(): Promise<T | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return null;
  return JSON.parse(text) as T;
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
