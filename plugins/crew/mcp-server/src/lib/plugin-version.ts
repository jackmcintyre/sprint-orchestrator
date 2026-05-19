import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginManifestSchema } from "../schemas/plugin-manifest.js";

/**
 * Resolve the plugin root from this module's location.
 *
 * Layout (relative to compiled dist):
 *   plugins/crew/                  <-- PLUGIN_ROOT
 *     mcp-server/dist/lib/plugin-version.js       <-- this file at runtime
 *     mcp-server/src/lib/plugin-version.ts        <-- this file at test time (vitest)
 *
 * Both layouts are three directories up from this file.
 */
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const MANIFEST_PATH = resolve(PLUGIN_ROOT, ".claude-plugin/plugin.json");

let cachedVersion: string | undefined;

/**
 * Returns the semver string from `.claude-plugin/plugin.json`.
 *
 * The value is parsed and validated against `PluginManifestSchema`
 * on first read, then cached. Stories 2.3, 4.7, and 4.9 call this
 * to stamp the plugin version onto personas, verdicts, and the
 * verdict footer marker.
 */
export function getPluginVersion(): string {
  if (cachedVersion !== undefined) {
    return cachedVersion;
  }
  const raw = readFileSync(MANIFEST_PATH, "utf8");
  const parsed = PluginManifestSchema.parse(JSON.parse(raw));
  cachedVersion = parsed.version;
  return cachedVersion;
}

/**
 * Test-only helper to clear the cached version. Not exported from
 * any public-facing barrel — intended for vitest only.
 */
export function __resetPluginVersionCacheForTests(): void {
  cachedVersion = undefined;
}
