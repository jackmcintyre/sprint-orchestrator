import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { registerAllTools } from "./tools/register.js";

/**
 * Stdio entrypoint referenced by `.claude-plugin/plugin.json#mcpServers`.
 *
 * Kept thin: instantiate the server, register the plugin's tools, then
 * connect a stdio transport. `registerAllTools` lives outside
 * `createServer` so the Story 1.1 smoke test can still assert that a
 * bare `createServer()` registers zero tools.
 */
async function main(): Promise<void> {
  const server = createServer();
  registerAllTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
