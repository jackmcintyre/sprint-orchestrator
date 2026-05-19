import { z } from "zod";
/**
 * Semver pattern accepted in `.claude-plugin/plugin.json#version`.
 * Matches `MAJOR.MINOR.PATCH` with optional `-prerelease` and `+build`.
 */
export declare const SEMVER_REGEX: RegExp;
export declare const PluginManifestSchema: z.ZodObject<{
    name: z.ZodString;
    version: z.ZodString;
    description: z.ZodString;
    mcpServers: z.ZodRecord<z.ZodString, z.ZodObject<{
        command: z.ZodString;
        args: z.ZodOptional<z.ZodArray<z.ZodString>>;
        env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, z.core.$loose>>;
    skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
    agents: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
