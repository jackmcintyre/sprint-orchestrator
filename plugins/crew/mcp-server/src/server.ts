import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getPluginVersion } from "./lib/plugin-version.js";
import { NotImplementedError, PermissionDeniedError } from "./errors.js";
import type { RolePermissions } from "./schemas/role-permissions.js";

/**
 * JSON Schema shape MCP clients expect for a tool's `inputSchema`.
 * We intentionally keep the typing loose (`Record<string, unknown>`)
 * because later stories may compose schemas from Zod, hand-written
 * JSON Schema, or generators — we don't want to lock the shape now.
 */
export interface ToolInputSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolCallResult {
  content: Array<{ type: "text"; text: string } | Record<string, unknown>>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Per-call role context, optionally threaded into a tool handler when
 * the MCP request carries `_meta.role`. Tools that don't need the
 * context just ignore `ctx`.
 */
export interface ToolHandlerContext {
  role?: string;
  permissions?: RolePermissions;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx?: ToolHandlerContext,
) => Promise<ToolCallResult> | ToolCallResult;

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  handler: ToolHandler;
  /**
   * Optional finer-grained per-tool role override. Currently reserved
   * for future stories — the dispatcher does not yet consume it; the
   * authoritative gate is the role's `tools_allow` allowlist.
   */
  allowedRoles?: readonly string[];
}

/**
 * Extension of the MCP `Server` that exposes the list of registered
 * tool names for in-process introspection (used by the smoke test).
 *
 * Every later story that registers a tool MUST go through
 * `registerTool()` on this wrapper so `ListToolsRequestSchema` and
 * `CallToolRequestSchema` stay in sync.
 */
export interface AiEngineeringTeamServer extends Server {
  getRegisteredToolNames(): string[];
  registerTool(descriptor: ToolDescriptor): void;
}

export interface CreateServerOptions {
  /**
   * Loader called once per CallToolRequest when the request carries a
   * `_meta.role` field. Default throws NotImplementedError to ensure
   * production wiring is explicit. Tests inject a fixture loader.
   */
  permissionsLoader?: (role: string) => Promise<RolePermissions>;
}

/**
 * Create the plugin's MCP server.
 *
 * - Instantiates `Server` with `name` and `version` (read from the
 *   plugin manifest), declaring the `tools` capability.
 * - Registers a `ListToolsRequestSchema` handler that returns the
 *   wrapper's currently-registered tool descriptors.
 * - Registers a `CallToolRequestSchema` handler that dispatches to
 *   the descriptor's handler. If the request carries `_meta.role`,
 *   the dispatcher consults `permissionsLoader(role)` and refuses
 *   any tool whose name is not in `tools_allow` (FR79/FR80/NFR12).
 *   The descriptor's handler is never invoked on refusal.
 * - Does NOT connect to any transport — the `index.ts` entrypoint
 *   wires up stdio. Keeping `createServer()` transport-free is what
 *   makes the smoke test runnable headless.
 */
export function createServer(opts?: CreateServerOptions): AiEngineeringTeamServer {
  const registered = new Map<string, ToolDescriptor>();

  const permissionsLoader =
    opts?.permissionsLoader ??
    (async () => {
      throw new NotImplementedError(
        "permissionsLoader not configured — pass one to createServer in production wiring (Story 1.7).",
      );
    });

  const server = new Server(
    { name: "crew", version: getPluginVersion() },
    { capabilities: { tools: {} } },
  ) as AiEngineeringTeamServer;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Array.from(registered.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const params = request.params as {
      name: string;
      arguments?: Record<string, unknown>;
      _meta?: { role?: string };
    };
    const { name, arguments: args, _meta } = params;
    const descriptor = registered.get(name);
    if (!descriptor) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    let ctx: ToolHandlerContext = {};
    if (_meta?.role) {
      const permissions = await permissionsLoader(_meta.role);
      if (!permissions.tools_allow.includes(name)) {
        const err = new PermissionDeniedError({
          role: _meta.role,
          attemptedTool: name,
          allowedTools: permissions.tools_allow,
          specPath: permissions.sourcePath,
        });
        return {
          content: [{ type: "text" as const, text: err.message }],
          isError: true,
        };
      }
      ctx = { role: _meta.role, permissions };
    }

    return descriptor.handler((args ?? {}) as Record<string, unknown>, ctx);
  });

  server.getRegisteredToolNames = () => Array.from(registered.keys());
  server.registerTool = (descriptor: ToolDescriptor) => {
    registered.set(descriptor.name, descriptor);
  };

  return server;
}
