import { type RolePermissions } from "../schemas/role-permissions.js";
/**
 * Resolve `<pluginRoot>/permissions/<role>.yaml`, parse, return typed.
 * Throws `RolePermissionsMissingError` on ENOENT,
 * `RolePermissionsMalformedError` on YAML-syntax or Zod failure.
 *
 * Single-purpose IO wrapper — no caching. Re-reads on every call.
 * `pluginRoot` flows in as a parameter; the loader does NOT derive it
 * from `process.cwd()` (memory `feedback_pre_tool_use_hook_cwd_drift`).
 */
export declare function loadRolePermissions(opts: {
    role: string;
    pluginRoot: string;
}): Promise<RolePermissions>;
