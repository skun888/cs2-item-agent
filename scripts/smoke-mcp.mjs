import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(projectRoot, "scripts", "run-mcp.mjs")],
  cwd: projectRoot,
  stderr: "pipe",
});
const client = new Client({ name: "cs2-item-agent-smoke", version: "0.8.0-alpha.1" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const health = await client.callTool({ name: "health_check", arguments: {} });
  const fees = await client.callTool({ name: "show_hanging_fee_assumptions", arguments: {} });
  const output = {
    connected: true,
    toolCount: tools.tools.length,
    toolNames: tools.tools.map((tool) => tool.name).sort(),
    health: health.structuredContent,
    fees: fees.structuredContent,
  };
  if (process.argv.includes("--decision")) {
    const decision = await client.callTool({
      name: "analyze_item_decision",
      arguments: {
        marketHashName: "M4A4 | Hellfire (Factory New)",
        platform: "STEAM",
        klineType: 1,
      },
    });
    const report = decision.structuredContent;
    output.decision = {
      isError: decision.isError ?? false,
      marketHashName: report?.marketHashName,
      generatedAt: report?.generatedAt,
      holderStatus: report?.holderCoverage?.status,
      supplyStatus: report?.supplyTrend?.status,
      decisionFrame: report?.decisionFrame,
    };
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} finally {
  await client.close();
}
