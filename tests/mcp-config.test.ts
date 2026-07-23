import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const launcherPath = "scripts/run-mcp.mjs";

test("project MCP configurations use the shared portable launcher", async () => {
  for (const relativePath of [".mcp.json", ".trae/mcp.json", ".workbuddy/mcp.json"]) {
    const content = await readFile(resolve(root, relativePath), "utf8");
    const config = JSON.parse(content) as {
      mcpServers: Record<string, { command: string; args: string[]; cwd?: string; env?: unknown }>;
    };
    assert.deepEqual(Object.keys(config.mcpServers), ["cs2-item-agent"]);
    const expectedServer =
      relativePath === ".trae/mcp.json"
        ? {
            command: "node",
            args: ["${workspaceFolder}/scripts/run-mcp.mjs"],
            cwd: "${workspaceFolder}",
          }
        : {
            command: "node",
            args: [launcherPath],
          };
    assert.deepEqual(config.mcpServers["cs2-item-agent"], expectedServer);
    assert.doesNotMatch(content, /[A-Za-z]:[\\/]/);
    assert.doesNotMatch(content, /(?:api[_-]?key|api[_-]?token|webhook|secret)/i);
  }

  const codex = await readFile(resolve(root, ".codex", "config.toml"), "utf8");
  assert.match(codex, /^\[mcp_servers\.cs2_item_agent\]$/m);
  assert.match(codex, /^command = "node"$/m);
  assert.match(codex, /^args = \["scripts\/run-mcp\.mjs"\]$/m);
  assert.match(codex, /^cwd = "\."$/m);
  assert.match(codex, /^startup_timeout_sec = 300$/m);
  assert.doesNotMatch(codex, /[A-Za-z]:[\\/]/);
  await readFile(resolve(root, launcherPath), "utf8");
});
