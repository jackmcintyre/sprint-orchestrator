/**
 * Permission policy for the SDK runner. Deny by default; only allow the
 * tool names the orchestrator skill, dev subagent, and reviewer subagent
 * legitimately need.
 *
 * Patterns (suffix-matched on tool name):
 *   - exact built-in names: "Read", "Write", "Edit", "MultiEdit", "Bash",
 *     "Glob", "Grep", "Task"
 *   - any tool emitted by our MCP server, namespaced as
 *     `mcp__sprint-orchestrator__*`
 *
 * Updates to this list should be matched against agents/*.md and skills/*.md
 * frontmatter — anything granted to the in-Claude-Code plugin must also be
 * granted here when running unattended.
 */
export const ALLOWED_BUILTIN_TOOLS = new Set<string>([
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Bash",
  "Glob",
  "Grep",
  "Task",
]);

export const ALLOWED_MCP_PREFIX = "mcp__sprint-orchestrator__";

export type Decision = { allow: true } | { allow: false; reason: string };

export function decide(toolName: string): Decision {
  if (ALLOWED_BUILTIN_TOOLS.has(toolName)) return { allow: true };
  if (toolName.startsWith(ALLOWED_MCP_PREFIX)) return { allow: true };
  return { allow: false, reason: `not-allowlisted:${toolName}` };
}
