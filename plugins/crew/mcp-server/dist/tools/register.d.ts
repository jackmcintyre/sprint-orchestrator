import type { AiEngineeringTeamServer } from "../server.js";
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
export declare function registerAllTools(server: AiEngineeringTeamServer): void;
