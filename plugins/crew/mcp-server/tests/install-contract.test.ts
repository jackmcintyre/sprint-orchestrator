import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MarketplaceManifestSchema } from "../src/schemas/marketplace-manifest.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(HERE, "../../../..");
const pluginRoot = path.resolve(repoRoot, "plugins/crew");

const CHECKPOINT_BLOCK_REGEX = /^\d+\.\s+\*\*[^*]+\.\*\*/gm;

function listMarkdownSkillsRelative(): string[] {
  const skillsRoot = path.join(pluginRoot, "skills");
  const out: string[] = [];
  function walk(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        if (entry.name === ".gitkeep") continue;
        if (!entry.name.endsWith(".md")) continue;
        const rel = path.relative(pluginRoot, full).split(path.sep).join("/");
        out.push(rel);
      }
    }
  }
  if (existsSync(skillsRoot) && statSync(skillsRoot).isDirectory()) {
    walk(skillsRoot);
  }
  return out.sort();
}

function readOptOut(): Set<string> {
  const optOutPath = path.join(pluginRoot, ".claude-plugin/skills-opt-out.txt");
  if (!existsSync(optOutPath)) return new Set();
  const lines = readFileSync(optOutPath, "utf8").split(/\r?\n/);
  const out = new Set<string>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    out.add(line);
  }
  return out;
}

describe("install-contract", () => {
  it("sanity — pluginRoot resolves to a directory containing .claude-plugin/plugin.json", () => {
    expect(existsSync(path.join(pluginRoot, ".claude-plugin/plugin.json"))).toBe(true);
  });

  it("AC4a — root marketplace.json exists, is valid JSON, satisfies the schema, lists crew@./plugins/crew", () => {
    const marketplacePath = path.join(repoRoot, ".claude-plugin/marketplace.json");
    expect(existsSync(marketplacePath)).toBe(true);
    const raw = readFileSync(marketplacePath, "utf8");
    const parsed = JSON.parse(raw);
    const manifest = MarketplaceManifestSchema.parse(parsed);
    expect(manifest.name).toBe("crew");
    const crewEntry = manifest.plugins.find((p) => p.name === "crew");
    expect(crewEntry).toBeDefined();
    expect(crewEntry?.source).toBe("./plugins/crew");
    const resolvedPluginJson = path.resolve(
      repoRoot,
      crewEntry!.source,
      ".claude-plugin/plugin.json",
    );
    expect(existsSync(resolvedPluginJson)).toBe(true);
  });

  it("AC4b — plugin.json's skills array lists every non-opt-out *.md file under skills/", () => {
    const pluginJsonPath = path.join(pluginRoot, ".claude-plugin/plugin.json");
    const manifest = JSON.parse(readFileSync(pluginJsonPath, "utf8")) as {
      skills?: string[];
    };
    const registered = new Set(manifest.skills ?? []);
    const globbed = listMarkdownSkillsRelative();
    const optOut = readOptOut();
    const expected = globbed.filter((p) => !optOut.has(p));
    const orphans = expected.filter((p) => !registered.has(p));
    if (orphans.length > 0) {
      const bullets = orphans.map((o) => `  - ${o}`).join("\n");
      const message =
        `Orphaned skill file(s) detected under plugins/crew/skills/:\n` +
        `${bullets}\n` +
        `Register each file in plugins/crew/.claude-plugin/plugin.json's "skills" array,\n` +
        `or add it to plugins/crew/.claude-plugin/skills-opt-out.txt (one path per line).`;
      throw new Error(message);
    }
    expect(orphans).toEqual([]);
  });

  it("AC4c — README-install.md contains '/plugin marketplace add .' and '/plugin install crew@crew' and does NOT contain '/plugin install plugins/crew'", () => {
    const readme = readFileSync(path.join(pluginRoot, "docs/README-install.md"), "utf8");
    expect(readme).toContain("/plugin marketplace add .");
    expect(readme).toContain("/plugin install crew@crew");
    expect(readme).not.toContain("/plugin install plugins/crew");
  });

  it("AC4c — README-install.md still matches Story 1.7's CHECKPOINT_BLOCK_REGEX with the expected count", () => {
    const readme = readFileSync(path.join(pluginRoot, "docs/README-install.md"), "utf8");
    const matches = readme.match(CHECKPOINT_BLOCK_REGEX) ?? [];
    expect(matches.length).toBe(6);
  });

  it("AC4c — README-install.md ends with the Story 7.2 forward-reference line", () => {
    const readme = readFileSync(path.join(pluginRoot, "docs/README-install.md"), "utf8");
    expect(readme.trimEnd().endsWith("> See Story 7.2 (Epic 7) for the full first-run walkthrough.")).toBe(true);
  });
});
