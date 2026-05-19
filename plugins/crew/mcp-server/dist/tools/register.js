import { z } from "zod";
import { getStatus, renderStatus } from "./get-status.js";
/**
 * Tool-registration seam. Every future story that ships an MCP tool
 * appends a `server.registerTool({...})` call here, keeping `server.ts`
 * free of tool-specific imports.
 *
 * Wired into `index.ts` (the stdio entrypoint) after `createServer()`
 * but BEFORE `server.connect(transport)`. NOT called from `createServer`
 * itself — the smoke test (`acceptance.test.ts` AC3) asserts that a
 * bare `createServer()` registers zero tools.
 */
export function registerAllTools(server) {
    server.registerTool({
        name: "getStatus",
        description: "Return a typed status report for the resolved target repo (plugin version, adapter, standards-doc state, cycle).",
        inputSchema: {
            type: "object",
            properties: {
                targetRepoRoot: { type: "string" },
            },
            required: ["targetRepoRoot"],
        },
        handler: async (args) => {
            const root = z.string().min(1).parse(args.targetRepoRoot);
            const report = await getStatus({ targetRepoRoot: root });
            return {
                content: [{ type: "text", text: renderStatus(report) }],
            };
        },
    });
}
