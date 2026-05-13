import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as YAML from "yaml";

import { type ToolContext } from "./context.js";
import { type SpawnRole, defaultModelForRole } from "./model-tiering-defaults.js";

/**
 * Resolve the model ID the orchestrator should pass to the Task tool when
 * spawning a `dev` or `reviewer` subagent for `storyId`.
 *
 * Resolution order (first hit wins):
 *   1. `models[role]` from `.sprint-orchestrator/config.yaml` (if present)
 *   2. The `model:` field in the matching agent file's YAML frontmatter
 *      (plugins/sprint-orchestrator/agents/<role>.md, or `agentsDir`
 *      override on the ToolContext)
 *   3. The matching `DEFAULT_*_MODEL` constant in
 *      `model-tiering-defaults.ts`
 *
 * Story 1 of model-tiering-v1 deliberately omits any escalation
 * branching (e.g. bump to Opus after N rework swings); that lands in
 * Story 2. `storyId` is accepted now so the signature is stable across
 * the slice without forcing a tool-schema rename later.
 */
export interface ResolveSpawnModelInput {
  storyId: string;
  role: SpawnRole;
}

export interface ResolveSpawnModelResult {
  model: string;
  /** Where the resolver actually picked the model from — for observability. */
  source: "config" | "frontmatter" | "fallback";
}

export async function resolveSpawnModel(
  ctx: ToolContext,
  input: ResolveSpawnModelInput,
): Promise<ResolveSpawnModelResult> {
  const { role } = input;

  // (1) Config override.
  const configModel = await readConfigModelForRole(ctx.configPath, role);
  if (configModel) {
    return { model: configModel, source: "config" };
  }

  // (2) Agent-file frontmatter.
  const agentsDir = resolveAgentsDir(ctx);
  const fmModel = await readFrontmatterModel(agentsDir, role);
  if (fmModel) {
    return { model: fmModel, source: "frontmatter" };
  }

  // (3) Static fallback constant.
  return { model: defaultModelForRole(role), source: "fallback" };
}

async function readConfigModelForRole(configPath: string, role: SpawnRole): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = YAML.parse(raw) as { models?: { dev?: unknown; reviewer?: unknown } } | null;
  const candidate = parsed?.models?.[role];
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return candidate.trim();
  }
  return null;
}

async function readFrontmatterModel(agentsDir: string, role: SpawnRole): Promise<string | null> {
  const filePath = path.join(agentsDir, `${role}.md`);
  let txt: string;
  try {
    txt = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const fm = extractFrontmatter(txt);
  if (!fm) return null;
  const parsed = YAML.parse(fm) as { model?: unknown } | null;
  const candidate = parsed?.model;
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return candidate.trim();
  }
  return null;
}

/**
 * Extract the YAML body between the opening `---` line and the next
 * `---` line at the top of an agent markdown file. Returns null when no
 * frontmatter block is present.
 */
function extractFrontmatter(text: string): string | null {
  // Tolerate a leading BOM / blank lines but require the very first
  // non-empty line to be `---`.
  const m = text.match(/^\s*---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  return m ? (m[1] ?? "") : null;
}

/**
 * Where to look for the agent markdown files. `ctx.agentsDir` overrides
 * (used by the e2e harness); otherwise we resolve the plugin-local
 * `agents/` directory from this module's filesystem location. Both the
 * built `dist/tools/resolve-spawn-model.js` and the source
 * `src/tools/resolve-spawn-model.ts` sit four levels deep under the
 * plugin root, so the same offset works in dev and after build.
 */
function resolveAgentsDir(ctx: ToolContext): string {
  if (ctx.agentsDir) return ctx.agentsDir;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // here = .../plugins/sprint-orchestrator/packages/mcp-server/{src,dist}/tools
  // pluginRoot = .../plugins/sprint-orchestrator
  const pluginRoot = path.resolve(here, "..", "..", "..", "..");
  return path.join(pluginRoot, "agents");
}
