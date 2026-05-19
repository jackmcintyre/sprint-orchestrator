import { z } from "zod";
/**
 * Semver pattern accepted in `.claude-plugin/plugin.json#version`.
 * Matches `MAJOR.MINOR.PATCH` with optional `-prerelease` and `+build`.
 */
export const SEMVER_REGEX = /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/;
const McpServerEntrySchema = z
    .object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
})
    .passthrough();
export const PluginManifestSchema = z
    .object({
    name: z.string().min(1),
    version: z.string().regex(SEMVER_REGEX, "version must be semver (MAJOR.MINOR.PATCH)"),
    description: z.string(),
    mcpServers: z.record(z.string(), McpServerEntrySchema),
    skills: z.array(z.string()).optional(),
    agents: z.array(z.string()).optional(),
})
    .strict();
