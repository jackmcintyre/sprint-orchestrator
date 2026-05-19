import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getPluginVersion } from "./lib/plugin-version.js";

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

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolCallResult> | ToolCallResult;

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  handler: ToolHandler;
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

/**
 * Create the plugin's MCP server.
 *
 * - Instantiates `Server` with `name` and `version` (read from the
 *   plugin manifest), declaring the `tools` capability.
 * - Registers a `ListToolsRequestSchema` handler that returns the
 *   wrapper's currently-registered tool descriptors (empty in
 *   Story 1.1).
 * - Registers a `CallToolRequestSchema` handler that dispatches to
 *   the descriptor's handler, returning a structured error if the
 *   tool is unknown.
 * - Does NOT connect to any transport — the `index.ts` entrypoint
 *   wires up stdio. Keeping `createServer()` transport-free is what
 *   makes the smoke test runnable headless.
 */
export function createServer(): AiEngineeringTeamServer {
  const registered = new Map<string, ToolDescriptor>();

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
    const { name, arguments: args } = request.params;
    const descriptor = registered.get(name);
    if (!descriptor) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    return descriptor.handler((args ?? {}) as Record<string, unknown>);
  });

  server.getRegisteredToolNames = () => Array.from(registered.keys());
  server.registerTool = (descriptor: ToolDescriptor) => {
    registered.set(descriptor.name, descriptor);
  };

  return server;
}
