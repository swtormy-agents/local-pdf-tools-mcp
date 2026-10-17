#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

async function main() {
  const config = loadConfig();
  const server = await createServer(config);
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel; diagnostics go to stderr only. No telemetry, no network.
  console.error(`${SERVER_NAME} ${SERVER_VERSION} ready. Allowed root: ${config.allowedRoot}`);
}

main().catch((e) => {
  console.error(`${SERVER_NAME}: ${(e as Error).message}`);
  process.exit(1);
});
