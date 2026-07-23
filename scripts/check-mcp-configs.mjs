import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const launcherPath = "scripts/run-mcp.mjs";
const jsonConfigPaths = [".mcp.json", ".trae/mcp.json", ".workbuddy/mcp.json"];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertPortable(content, relativePath) {
  assert(!/[A-Za-z]:[\\/]/.test(content), `${relativePath} contains a Windows absolute path`);
  assert(!/\\\\[^\\]/.test(content), `${relativePath} contains a UNC path`);
  assert(!/\/(?:Users|home|root)\//.test(content), `${relativePath} contains a user-specific absolute path`);
  assert(!/(?:api[_-]?key|api[_-]?token|webhook|secret)/i.test(content), `${relativePath} contains a secret field`);
}

for (const relativePath of jsonConfigPaths) {
  const content = await readFile(resolve(projectRoot, relativePath), "utf8");
  assertPortable(content, relativePath);

  const config = JSON.parse(content);
  const servers = config.mcpServers;
  assert(servers && typeof servers === "object", `${relativePath} must define mcpServers`);
  assert(Object.keys(servers).length === 1, `${relativePath} must define exactly one MCP server`);

  const server = servers["cs2-item-agent"];
  assert(server && typeof server === "object", `${relativePath} must define cs2-item-agent`);
  assert(server.command === "node", `${relativePath} must invoke Node.js from PATH`);
  const expectedLauncherPath =
    relativePath === ".trae/mcp.json" ? "${workspaceFolder}/scripts/run-mcp.mjs" : launcherPath;
  assert(
    Array.isArray(server.args) && server.args.length === 1 && server.args[0] === expectedLauncherPath,
    `${relativePath} must invoke the shared MCP launcher`,
  );
  if (relativePath === ".trae/mcp.json") {
    assert(
      server.cwd === "${workspaceFolder}",
      `${relativePath} must launch from the Trae workspace root`,
    );
  }
  assert(!("env" in server), `${relativePath} must not copy secrets into MCP configuration`);
}

const codexPath = ".codex/config.toml";
const codex = await readFile(resolve(projectRoot, codexPath), "utf8");
assertPortable(codex, codexPath);
assert(/^\[mcp_servers\.cs2_item_agent\]$/m.test(codex), `${codexPath} must define cs2_item_agent`);
assert(/^command = "node"$/m.test(codex), `${codexPath} must invoke Node.js from PATH`);
assert(/^args = \["scripts\/run-mcp\.mjs"\]$/m.test(codex), `${codexPath} must invoke the shared MCP launcher`);
assert(/^cwd = "\."$/m.test(codex), `${codexPath} must use the project root as cwd`);
assert(/^startup_timeout_sec = 300$/m.test(codex), `${codexPath} must allow first-run bootstrap time`);
assert(/^enabled = true$/m.test(codex), `${codexPath} must enable the server`);

await readFile(resolve(projectRoot, launcherPath), "utf8");
console.log(`Validated ${jsonConfigPaths.length + 1} project-level MCP configurations.`);
