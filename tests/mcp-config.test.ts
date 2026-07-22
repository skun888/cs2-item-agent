import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const launcherPath = "scripts/run-mcp.mjs";

test("project MCP configurations use the shared path-free launcher", async () => {
  for (const relativePath of [".mcp.json", ".workbuddy/mcp.json"]) {
    const content = await readFile(resolve(root, relativePath), "utf8");
    const config = JSON.parse(content) as {
      mcpServers: Record<string, { command: string; args: string[]; env?: unknown }>;
    };
    assert.deepEqual(Object.keys(config.mcpServers), ["cs2-item-agent"]);
    assert.deepEqual(config.mcpServers["cs2-item-agent"], {
      command: "node",
      args: [launcherPath],
    });
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
