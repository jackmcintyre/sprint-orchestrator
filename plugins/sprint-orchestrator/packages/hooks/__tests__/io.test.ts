import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.resolve(__dirname, "fixtures/echo-stdin.mjs");

describe("readStdinJson via subprocess", () => {
  it("returns null on empty stdin", () => {
    const r = spawnSync("node", [HARNESS], { input: "", encoding: "utf8" });
    expect(r.stdout.trim()).toBe("null");
  });

  it("parses a JSON payload", () => {
    const r = spawnSync("node", [HARNESS], { input: '{"a":1}\n', encoding: "utf8" });
    expect(JSON.parse(r.stdout)).toEqual({ a: 1 });
  });
});
