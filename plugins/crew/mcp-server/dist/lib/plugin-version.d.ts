/**
 * Returns the semver string from `.claude-plugin/plugin.json`.
 *
 * The value is parsed and validated against `PluginManifestSchema`
 * on first read, then cached. Stories 2.3, 4.7, and 4.9 call this
 * to stamp the plugin version onto personas, verdicts, and the
 * verdict footer marker.
 */
export declare function getPluginVersion(): string;
/**
 * Test-only helper to clear the cached version. Not exported from
 * any public-facing barrel — intended for vitest only.
 */
export declare function __resetPluginVersionCacheForTests(): void;
