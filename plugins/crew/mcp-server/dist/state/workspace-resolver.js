import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { adapters as registryAdapters } from "../adapters/registry.js";
import { AmbiguousAdapterError, InvalidWorkspaceConfigError, NoAdapterMatchedError, } from "../errors.js";
import { PluginSettingsSchema, WorkspaceConfigSchema, } from "../schemas/workspace-config.js";
import { writeManagedFile } from "../lib/managed-fs.js";
const SCHEMA_MODULE = "mcp-server/src/schemas/workspace-config.ts";
const CONFIG_REL_PATH = path.join(".crew", "config.yaml");
async function fileExists(p) {
    try {
        await fs.stat(p);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Resolve `<targetRepoRoot>/.crew/config.yaml` into a typed
 * `Workspace`. Auto-detects on first use; surfaces typed errors for
 * missing-adapter, ambiguous-adapter, and invalid-config cases.
 *
 * Pure function — no module-level caching, no global state mutation
 * beyond the single config-write on first-run unambiguous detect.
 */
export async function resolveWorkspace(opts) {
    const targetRepoRoot = path.resolve(opts.targetRepoRoot);
    const adapters = opts.adapters ?? registryAdapters;
    const configPath = path.join(targetRepoRoot, CONFIG_REL_PATH);
    if (!(await fileExists(configPath))) {
        // Branch A — no config: run detect() across the registry.
        const detectResults = await Promise.all(adapters.map((a) => a.detect(targetRepoRoot)));
        const matches = adapters.filter((_, i) => detectResults[i] === true);
        if (matches.length === 0) {
            throw new NoAdapterMatchedError({
                targetRepoRoot,
                registeredAdapters: adapters.map((a) => a.name),
            });
        }
        if (matches.length >= 2) {
            throw new AmbiguousAdapterError({
                targetRepoRoot,
                matchingAdapters: matches.map((a) => a.name),
            });
        }
        const matched = matches[0];
        const synthesised = WorkspaceConfigSchema.parse({
            adapter: matched.name,
            adapter_config: matched.defaultConfig(),
            plugin: {},
        });
        // Route through writeManagedFile so the canonical-fs write boundary
        // is the only entrypoint that touches disk under <targetRepoRoot>.
        // `.crew/config.yaml` is non-canonical (it's user-authored
        // config, not agent-managed state), so this call passes through without
        // an mcpToolContext.
        await writeManagedFile({
            absPath: configPath,
            contents: yamlStringify(synthesised),
            targetRepoRoot,
        });
        // Fall through to Branch B — re-read what we just wrote so the
        // same code path validates it, defending against write/read drift.
    }
    // Branch B — config file exists.
    const raw = await fs.readFile(configPath, "utf8");
    let parsedYaml;
    try {
        parsedYaml = yamlParse(raw);
    }
    catch (err) {
        throw new InvalidWorkspaceConfigError({
            configPath,
            yamlPath: "(root)",
            zodMessage: err instanceof Error ? err.message : String(err),
            schemaModule: SCHEMA_MODULE,
        });
    }
    if (parsedYaml === undefined || parsedYaml === null) {
        throw new InvalidWorkspaceConfigError({
            configPath,
            yamlPath: "(root)",
            zodMessage: "config.yaml is empty",
            schemaModule: SCHEMA_MODULE,
        });
    }
    const parsed = WorkspaceConfigSchema.safeParse(parsedYaml);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new InvalidWorkspaceConfigError({
            configPath,
            yamlPath: issue.path.length === 0 ? "(root)" : issue.path.join("."),
            zodMessage: issue.message,
            schemaModule: SCHEMA_MODULE,
        });
    }
    const config = parsed.data;
    const activeAdapter = adapters.find((a) => a.name === config.adapter);
    if (!activeAdapter) {
        throw new InvalidWorkspaceConfigError({
            configPath,
            yamlPath: "adapter",
            zodMessage: `unknown adapter '${config.adapter}' — registered: [${adapters
                .map((a) => a.name)
                .join(", ")}]`,
            schemaModule: SCHEMA_MODULE,
        });
    }
    const adapterParsed = activeAdapter.adapterConfigSchema.safeParse(config.adapter_config);
    if (!adapterParsed.success) {
        const issue = adapterParsed.error.issues[0];
        const subPath = issue.path.length === 0 ? "adapter_config" : `adapter_config.${issue.path.join(".")}`;
        throw new InvalidWorkspaceConfigError({
            configPath,
            yamlPath: subPath,
            zodMessage: issue.message,
            schemaModule: SCHEMA_MODULE,
        });
    }
    // `WorkspaceConfigSchema` already applies plugin-settings defaults, but
    // re-parse defensively in case future edits to the top-level schema
    // weaken that guarantee.
    const pluginSettings = PluginSettingsSchema.parse(config.plugin);
    return {
        targetRepoRoot,
        activeAdapterName: activeAdapter.name,
        activeAdapter,
        adapterConfig: adapterParsed.data,
        pluginSettings,
    };
}
