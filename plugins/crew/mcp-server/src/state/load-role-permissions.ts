import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
import { z } from "zod";
import {
  RolePermissionsMalformedError,
  RolePermissionsMissingError,
} from "../errors.js";
import {
  RolePermissionsSchema,
  type RolePermissions,
} from "../schemas/role-permissions.js";

/**
 * Format a list of Zod issues into a one-line, user-facing string.
 * Mirrors the helper in `validators/standards-doc.ts`. Duplicated here
 * by design — extracting to a shared `lib/format-zod-issues.ts` was
 * scoped out of Story 1.4 to avoid touching the 1.3 validator.
 */
function formatZodIssues(issues: z.ZodIssue[]): string {
  const first = issues[0];
  if (!first) return "(no issue details)";
  const dottedPath = first.path.length > 0 ? first.path.join(".") : "<root>";
  return `${dottedPath}: ${first.message}`;
}

/**
 * Resolve `<pluginRoot>/permissions/<role>.yaml`, parse, return typed.
 * Throws `RolePermissionsMissingError` on ENOENT,
 * `RolePermissionsMalformedError` on YAML-syntax or Zod failure.
 *
 * Single-purpose IO wrapper — no caching. Re-reads on every call.
 * `pluginRoot` flows in as a parameter; the loader does NOT derive it
 * from `process.cwd()` (memory `feedback_pre_tool_use_hook_cwd_drift`).
 */
export async function loadRolePermissions(opts: {
  role: string;
  pluginRoot: string;
}): Promise<RolePermissions> {
  const specPath = path.join(opts.pluginRoot, "permissions", `${opts.role}.yaml`);

  let raw: string;
  try {
    raw = await fs.readFile(specPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RolePermissionsMissingError({ role: opts.role, specPath });
    }
    throw err;
  }

  let parsedYaml: unknown;
  try {
    parsedYaml = yamlParse(raw);
  } catch (err) {
    throw new RolePermissionsMalformedError({
      specPath,
      zodMessage: err instanceof Error ? err.message : String(err),
    });
  }

  const result = RolePermissionsSchema.safeParse(parsedYaml);
  if (!result.success) {
    throw new RolePermissionsMalformedError({
      specPath,
      zodMessage: formatZodIssues(result.error.issues),
    });
  }

  return { ...result.data, sourcePath: specPath };
}
