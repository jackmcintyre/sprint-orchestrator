import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { lookupStandards } from "../src/state/lookup-standards.js";
import { parseStandardsDoc } from "../src/validators/standards-doc.js";
import {
  StandardsDocMalformedError,
  StandardsDocMissingError,
} from "../src/errors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "standards");
const EXAMPLE_PATH = path.resolve(HERE, "..", "..", "docs", "standards-example.md");

async function copyFixtureToTmp(fixtureName: string): Promise<string> {
  const src = path.join(FIXTURES, fixtureName);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `stdoc-${fixtureName}-`));
  await fs.cp(src, tmp, { recursive: true });
  return tmp;
}

describe("lookupStandards", () => {
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

  it("AC5a (missing): throws StandardsDocMissingError naming expected path and copy-target", async () => {
    const tmp = await copyFixtureToTmp("missing");
    tmpDirs.push(tmp);

    await expect(lookupStandards(tmp)).rejects.toBeInstanceOf(StandardsDocMissingError);

    try {
      await lookupStandards(tmp);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StandardsDocMissingError);
      const e = err as StandardsDocMissingError;
      const expectedPath = path.join(tmp, "docs", "standards.md");
      expect(e.expectedPath).toBe(expectedPath);
      expect(e.message).toContain(expectedPath);
      expect(e.message).toContain("standards-example.md");
      expect(e.message).toContain("(FR45)");
    }
  });

  it("AC5b (malformed — missing field): throws StandardsDocMalformedError mentioning the field, with non-empty zodMessage", async () => {
    const tmp = await copyFixtureToTmp("malformed-missing-field");
    tmpDirs.push(tmp);

    await expect(lookupStandards(tmp)).rejects.toBeInstanceOf(StandardsDocMalformedError);

    try {
      await lookupStandards(tmp);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StandardsDocMalformedError);
      const e = err as StandardsDocMalformedError;
      expect(e.message).toContain("version");
      expect(e.zodMessage.length).toBeGreaterThan(0);
      expect(e.message).toContain("standards-example.md");
    }
  });

  it("AC5c (malformed — cap exceeded): throws StandardsDocMalformedError citing the hard cap and FR46", async () => {
    const tmp = await copyFixtureToTmp("malformed-cap-exceeded");
    tmpDirs.push(tmp);

    await expect(lookupStandards(tmp)).rejects.toBeInstanceOf(StandardsDocMalformedError);

    try {
      await lookupStandards(tmp);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StandardsDocMalformedError);
      const e = err as StandardsDocMalformedError;
      expect(e.message).toContain("exceeds hard cap of 10");
      expect(e.message).toContain("(FR46)");
      expect(e.zodMessage).toContain("criteria.length=11");
    }
  });

  it("AC5d (valid): returns a parsed StandardsDoc with version, updated, criteria[] and sourcePath", async () => {
    // Build a `valid/docs/standards.md` fixture at runtime from the shipped example.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "stdoc-valid-"));
    tmpDirs.push(tmp);
    await fs.mkdir(path.join(tmp, "docs"), { recursive: true });
    await fs.copyFile(EXAMPLE_PATH, path.join(tmp, "docs", "standards.md"));

    const result = await lookupStandards(tmp);

    expect(result.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof result.updated).toBe("string");
    expect(result.updated.length).toBeGreaterThan(0);
    expect(result.criteria.length).toBeGreaterThanOrEqual(1);
    expect(result.criteria.length).toBeLessThanOrEqual(10);
    expect(result.sourcePath).toBe(path.join(tmp, "docs", "standards.md"));

    const first = result.criteria[0]!;
    for (const key of ["name", "what", "check", "anti_criterion"] as const) {
      expect(typeof first[key]).toBe("string");
      expect(first[key].length).toBeGreaterThan(0);
    }
  });
});

describe("standards-example.md (shipped copy-target)", () => {
  it("AC5e: parseStandardsDoc succeeds against the shipped example file", () => {
    const raw = readFileSync(EXAMPLE_PATH, "utf8");
    const result = parseStandardsDoc(raw, EXAMPLE_PATH);

    expect(result.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.criteria.length).toBeGreaterThanOrEqual(1);
    expect(result.criteria.length).toBeLessThanOrEqual(10);
    expect(result.sourcePath).toBe(EXAMPLE_PATH);
  });
});
