import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { logTelemetryEvent } from "../src/lib/logger.js";
import { TelemetryEventInvalidError } from "../src/errors.js";

const tmpDirs: string[] = [];

afterAll(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      await fs.rm(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function makeTargetRepo(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(root);
  return root;
}

function telemetryDir(root: string): string {
  return path.join(root, ".crew", "telemetry");
}

async function readJsonlLines(filePath: string): Promise<string[]> {
  const body = await fs.readFile(filePath, "utf8");
  const trailing = body.endsWith("\n");
  expect(trailing, `file '${filePath}' does not end with '\\n'`).toBe(true);
  return body.slice(0, body.length - 1).split("\n");
}

describe("logTelemetryEvent — happy path (AC6a)", () => {
  it("appends a single JSONL line with a UTC ms-precise ts and round-trips", async () => {
    const root = await makeTargetRepo("telemetry-logger-happy-");

    const event = {
      type: "agent.invoke" as const,
      session_id: "session-abc",
      agent: "generalist-dev",
      story_id: "bmad:1.5",
      data: { runtime_ms: 1234 },
    };

    await logTelemetryEvent({ targetRepoRoot: root, event });

    const entries = await fs.readdir(telemetryDir(root));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^\d{4}-\d{2}\.jsonl$/);

    const filePath = path.join(telemetryDir(root), entries[0]!);
    const lines = await readJsonlLines(filePath);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.type).toBe("agent.invoke");
    expect(parsed.session_id).toBe("session-abc");
    expect(parsed.agent).toBe("generalist-dev");
    expect(parsed.story_id).toBe("bmad:1.5");
    expect(parsed.data).toEqual({ runtime_ms: 1234 });
    expect(typeof parsed.ts).toBe("string");
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("logTelemetryEvent — Zod failure path (AC6b)", () => {
  it("throws TelemetryEventInvalidError AND writes a telemetry.invalid event", async () => {
    const root = await makeTargetRepo("telemetry-logger-invalid-");

    // Invalid: `runtime_ms` is a string instead of a number.
    const invalidEvent = {
      type: "agent.invoke",
      session_id: "session-xyz",
      agent: "generalist-dev",
      story_id: "bmad:1.5",
      data: { runtime_ms: "fast" },
    } as unknown as Parameters<typeof logTelemetryEvent>[0]["event"];

    await expect(
      logTelemetryEvent({ targetRepoRoot: root, event: invalidEvent }),
    ).rejects.toBeInstanceOf(TelemetryEventInvalidError);

    const entries = await fs.readdir(telemetryDir(root));
    expect(entries).toHaveLength(1);

    const filePath = path.join(telemetryDir(root), entries[0]!);
    const lines = await readJsonlLines(filePath);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.type).toBe("telemetry.invalid");
    expect(parsed.session_id).toBe("session-xyz");
    expect(parsed.agent).toBe("generalist-dev");
    expect(parsed.data.attempted_type).toBe("agent.invoke");
    expect(parsed.data.zod_path).toBe("data.runtime_ms");
    expect(parsed.data.zod_message).toBeTruthy();
    expect(typeof parsed.data.zod_message).toBe("string");
  });
});

describe("logTelemetryEvent — month rollover (AC6c)", () => {
  it("partitions events into two month-bucketed files with no cross-month interleaving", async () => {
    const root = await makeTargetRepo("telemetry-logger-rollover-");

    await logTelemetryEvent({
      targetRepoRoot: root,
      event: {
        type: "agent.invoke",
        session_id: "session-april",
        agent: "generalist-dev",
        data: { runtime_ms: 10 },
      },
      now: () => new Date("2026-04-30T23:59:59.500Z"),
    });

    await logTelemetryEvent({
      targetRepoRoot: root,
      event: {
        type: "agent.invoke",
        session_id: "session-may",
        agent: "generalist-dev",
        data: { runtime_ms: 20 },
      },
      now: () => new Date("2026-05-01T00:00:00.500Z"),
    });

    const entries = (await fs.readdir(telemetryDir(root))).sort();
    expect(entries).toEqual(["2026-04.jsonl", "2026-05.jsonl"]);

    const aprilLines = await readJsonlLines(
      path.join(telemetryDir(root), "2026-04.jsonl"),
    );
    const mayLines = await readJsonlLines(
      path.join(telemetryDir(root), "2026-05.jsonl"),
    );

    expect(aprilLines).toHaveLength(1);
    expect(mayLines).toHaveLength(1);

    const aprilParsed = JSON.parse(aprilLines[0]!);
    const mayParsed = JSON.parse(mayLines[0]!);
    expect(aprilParsed.session_id).toBe("session-april");
    expect(aprilParsed.ts.startsWith("2026-04-")).toBe(true);
    expect(mayParsed.session_id).toBe("session-may");
    expect(mayParsed.ts.startsWith("2026-05-")).toBe(true);
  });
});
