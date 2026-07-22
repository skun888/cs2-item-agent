import { existsSync, readFileSync } from "node:fs";
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
const expectedToolCount = 42;

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const health = await client.callTool({ name: "health_check", arguments: {} });
  const fees = await client.callTool({ name: "show_hanging_fee_assumptions", arguments: {} });
  assertAcceptance(tools, health);
  const output = {
    connected: true,
    acceptance: {
      toolSurface: "passed",
      health: "passed",
      onboarding: "passed",
      configurationGuide: "passed",
      secretFieldBoundary: "passed",
    },
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

function assertAcceptance(tools, health) {
  if (tools.tools.length !== expectedToolCount) {
    throw new Error(`MCP acceptance failed: expected ${expectedToolCount} tools, received ${tools.tools.length}.`);
  }
  if (health.isError || !isRecord(health.structuredContent) || health.structuredContent.ok !== true) {
    throw new Error("MCP acceptance failed: health_check did not return ok=true.");
  }

  const report = health.structuredContent;
  if (!isRecord(report.usageGuide) || report.usageGuide.language !== "zh-CN") {
    throw new Error("MCP acceptance failed: built-in Chinese usageGuide is missing.");
  }
  if (!isRecord(report.configurationGuide) || report.configurationGuide.envFile !== ".env") {
    throw new Error("MCP acceptance failed: configurationGuide is missing.");
  }

  const entries = report.configurationGuide.entries;
  const expectedVariables = ["STEAMDT_API_KEY", "CSQAQ_API_TOKEN", "STEAM_PROXY_URL", "WECHAT_WEBHOOK_URL"];
  if (!Array.isArray(entries) || entries.length !== expectedVariables.length) {
    throw new Error("MCP acceptance failed: configurationGuide entries are incomplete.");
  }
  for (const variable of expectedVariables) {
    const entry = entries.find((candidate) => isRecord(candidate) && candidate.variable === variable);
    if (!isRecord(entry) || !["not_configured", "configured_unverified"].includes(entry.status)) {
      throw new Error(`MCP acceptance failed: invalid configuration status for ${variable}.`);
    }
  }

  const forbiddenFields = new Set(["apikey", "apitoken", "webhookurl", "proxyurl"]);
  assertNoForbiddenFields(report, forbiddenFields);
  assertConfiguredSecretsAreAbsent(report);
}

function assertNoForbiddenFields(value, forbiddenFields) {
  if (Array.isArray(value)) {
    for (const entry of value) assertNoForbiddenFields(entry, forbiddenFields);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenFields.has(key.toLowerCase())) {
      throw new Error("MCP acceptance failed: health_check exposed a forbidden secret-bearing field.");
    }
    assertNoForbiddenFields(nested, forbiddenFields);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function assertConfiguredSecretsAreAbsent(report) {
  const envPath = resolve(projectRoot, ".env");
  if (!existsSync(envPath)) return;

  const envText = readFileSync(envPath, "utf8");
  const serializedReport = JSON.stringify(report);
  for (const variable of ["STEAMDT_API_KEY", "CSQAQ_API_TOKEN", "WECHAT_WEBHOOK_URL"]) {
    const value = readEnvValue(envText, variable);
    if (value && value.length >= 8 && serializedReport.includes(value)) {
      throw new Error("MCP acceptance failed: health_check exposed a configured secret value.");
    }
  }
}

function readEnvValue(envText, variable) {
  const match = envText.match(new RegExp(`^${variable}=(.*)$`, "m"));
  if (!match) return undefined;
  const raw = match[1].trim();
  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}
