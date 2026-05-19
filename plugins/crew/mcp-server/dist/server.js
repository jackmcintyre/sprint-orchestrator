import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getPluginVersion } from "./lib/plugin-version.js";
import { NotImplementedError, PermissionDeniedError } from "./errors.js";
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
export function createServer(opts) {
    const registered = new Map();
    const permissionsLoader = opts?.permissionsLoader ??
        (async () => {
            throw new NotImplementedError("permissionsLoader not configured — pass one to createServer in production wiring (Story 1.7).");
        });
    const server = new Server({ name: "crew", version: getPluginVersion() }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: Array.from(registered.values()).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
        })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const params = request.params;
        const { name, arguments: args, _meta } = params;
        const descriptor = registered.get(name);
        if (!descriptor) {
            return {
                content: [{ type: "text", text: `Unknown tool: ${name}` }],
                isError: true,
            };
        }
        let ctx = {};
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
                    content: [{ type: "text", text: err.message }],
                    isError: true,
                };
            }
            ctx = { role: _meta.role, permissions };
        }
        return descriptor.handler((args ?? {}), ctx);
    });
    server.getRegisteredToolNames = () => Array.from(registered.keys());
    server.registerTool = (descriptor) => {
        registered.set(descriptor.name, descriptor);
    };
    return server;
}
