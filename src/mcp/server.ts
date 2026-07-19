import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/index.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { ensureDataDirs } from "../util/paths.js";
import { listLiveInstances } from "../bridge/client.js";
import { log } from "../util/logging.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "ae-mcp",
    version: "0.1.0",
  });

  registerTools(server);
  registerResources(server);
  registerPrompts(server);

  return server;
}

export async function serveStdio(): Promise<void> {
  ensureDataDirs();
  log.info("starting ae-mcp stdio server");

  // NEVER auto-run AfterFX -r on startup — that is the "Executing script…" popup.
  // Bridge must come from AE Startup bootstrap (silent) after a normal AE launch.
  const live = listLiveInstances(60_000).length;
  log.info("startup bridge status", {
    liveInstances: live,
    note: live
      ? "bridge live — no inject"
      : "no heartbeat yet — open/restart AE once (Startup script), do not spam ensure",
  });

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("ae-mcp connected on stdio");
}
