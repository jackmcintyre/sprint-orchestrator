/**
 * Pre-PR gate (user-surface) harness for Story 1.8.
 *
 * Drives `python3 .claude/skills/ship-story/scripts/ship.py pre-pr-gate <key>`
 * against synthetic fixtures via execa. The gate is implemented in Python; this
 * vitest suite is the canonical contract test for AC4 (cases i–iv).
 *
 * Pattern: vitest-driven subprocess invocation. The fixture spec is fed to the
 * gate via `--spec-path`, and the fixture run log is fed via the
 * `CREW_SHIP_RUNS_DIR` env var so the test never pollutes the real run log.
 */
import { describe, it, expect } from "vitest";
import { execa } from "execa";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const SHIP_PY = resolve(REPO_ROOT, ".claude/skills/ship-story/scripts/ship.py");
const FIXTURES = resolve(HERE, "fixtures/pre-pr-gate");
const EXIT_USER_SURFACE_UNVERIFIED = 42;

async function runGate(caseDir: string, storyKey: string) {
  const specPath = resolve(FIXTURES, caseDir, "spec.md");
  const runsDir = resolve(FIXTURES, caseDir, "runs");
  const result = await execa(
    "python3",
    [SHIP_PY, "pre-pr-gate", storyKey, "--spec-path", specPath],
    {
      env: { ...process.env, CREW_SHIP_RUNS_DIR: runsDir },
      reject: false,
    },
  );
  return result;
}

describe("ship.py pre-pr-gate (Story 1.8 AC4)", () => {
  it("case i — user-surface AC with empty run log fails with USER_SURFACE_UNVERIFIED (AC3, AC4-i)", async () => {
    // The on-disk fixture file exists but is empty (zero bytes). The gate
    // must treat "present but empty" the same as "missing entirely".
    const r = await runGate("case-i-missing", "case-i-missing");
    expect(r.exitCode).toBe(EXIT_USER_SURFACE_UNVERIFIED);
    expect(r.stderr).toMatch(/AC1/);
    expect(r.stderr).toMatch(/Missing user-surface verification/);
  });

  it("case i variant — user-surface AC with NO run log file at all also fails (AC3)", async () => {
    // Distinguishes "file missing" from "file present but empty" — both must
    // yield the same USER_SURFACE_UNVERIFIED result.
    const specPath = resolve(FIXTURES, "case-i-missing", "spec.md");
    const emptyRunsDir = mkdtempSync(resolve(tmpdir(), "ship-runs-"));
    const r = await execa(
      "python3",
      [SHIP_PY, "pre-pr-gate", "case-i-missing", "--spec-path", specPath],
      { env: { ...process.env, CREW_SHIP_RUNS_DIR: emptyRunsDir }, reject: false },
    );
    expect(r.exitCode).toBe(EXIT_USER_SURFACE_UNVERIFIED);
    expect(r.stderr).toMatch(/Missing user-surface verification/);
  });

  it("case ii — valid user_surface_verified event passes (AC2, AC4-ii)", async () => {
    const r = await runGate("case-ii-passing", "case-ii-passing");
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.gate).toBe("pre-pr");
    expect(out.status).toBe("passed");
    expect(out.route).toBe("operator");
    expect(out.ac_refs).toEqual([1]);
  });

  it("case iii — no user-surface ACs with empty run log → gate skipped (AC4-iii)", async () => {
    // Fixture run log is present but empty (zero bytes); skipped is the
    // correct no-op outcome.
    const r = await runGate("case-iii-no-surface", "case-iii-no-surface");
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.gate).toBe("pre-pr");
    expect(out.status).toBe("skipped");
    expect(out.reason).toMatch(/no user-surface ACs/);
  });

  it("case iii variant — no user-surface ACs with NO run log file → still skipped (no-op)", async () => {
    // Distinguishes "file missing" from "file present but empty" — both must
    // yield the same skipped no-op for specs with no user-surface ACs.
    const specPath = resolve(FIXTURES, "case-iii-no-surface", "spec.md");
    const emptyRunsDir = mkdtempSync(resolve(tmpdir(), "ship-runs-"));
    const r = await execa(
      "python3",
      [SHIP_PY, "pre-pr-gate", "case-iii-no-surface", "--spec-path", specPath],
      { env: { ...process.env, CREW_SHIP_RUNS_DIR: emptyRunsDir }, reject: false },
    );
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.status).toBe("skipped");
  });

  it("case iv-a — event missing data.ac_refs is rejected with MalformedVerificationEvent (AC4-iv-a)", async () => {
    const r = await runGate(
      "case-iv-a-malformed-missing-ac-refs",
      "case-iv-a-malformed-missing-ac-refs",
    );
    expect(r.exitCode).toBe(EXIT_USER_SURFACE_UNVERIFIED);
    expect(r.stderr).toContain("MalformedVerificationEvent");
    expect(r.stderr).toMatch(/ac_refs/);
  });

  it("case iv-b — observation missing pasted_output is rejected with MalformedVerificationEvent (AC4-iv-b)", async () => {
    const r = await runGate(
      "case-iv-b-malformed-missing-pasted-output",
      "case-iv-b-malformed-missing-pasted-output",
    );
    expect(r.exitCode).toBe(EXIT_USER_SURFACE_UNVERIFIED);
    expect(r.stderr).toContain("MalformedVerificationEvent");
    expect(r.stderr).toMatch(/pasted_output/);
  });
});

describe("ship.py record-verification (Story 1.8 Task 4.3)", () => {
  it("rejects malformed payload at write time (missing ac_refs) with exit 2", async () => {
    const runsDir = resolve(FIXTURES, "case-i-missing", "runs"); // safe to reuse — append-only
    const data = JSON.stringify({
      operator: "jack",
      observations: [{ ac_ref: 1, pasted_output: "x" }],
    });
    const r = await execa(
      "python3",
      [
        SHIP_PY,
        "record-verification",
        "write-time-test",
        "--type",
        "user_surface_verified",
        "--data",
        data,
      ],
      { env: { ...process.env, CREW_SHIP_RUNS_DIR: runsDir }, reject: false },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("MalformedVerificationEvent");
  });
});
