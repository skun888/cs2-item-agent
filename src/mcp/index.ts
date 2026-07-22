#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMcpServer } from "./create-server.js";
import { createMcpRuntime } from "./runtime.js";

const runtime = createMcpRuntime();
const server = createMcpServer(runtime.dependencies);

async function shutdown(): Promise<void> {
  await server.close();
  runtime.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

server.connect(new StdioServerTransport()).catch((error: unknown) => {
  process.stderr.write(
    `CS2 Item Agent MCP failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  runtime.close();
  process.exitCode = 1;
});
