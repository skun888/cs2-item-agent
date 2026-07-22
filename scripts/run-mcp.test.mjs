import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  assertSupportedNode,
  ensureEnvFile,
  needsBuild,
  needsDependencyInstall,
  npmExecutable,
  npmInvocation,
  parseNodeMajor,
  runCommand,
} from "./run-mcp.mjs";

async function withTemporaryProject(run) {
  const root = await mkdtemp(resolve(tmpdir(), "cs2-item-agent-bootstrap-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("bootstrap enforces Node.js 24 without trying to install the runtime", () => {
  assert.equal(parseNodeMajor("v24.13.1"), 24);
  assert.equal(parseNodeMajor("25.0.0"), 25);
  assert.throws(() => assertSupportedNode("23.9.0"), /Node\.js 24 or newer/);
  assert.doesNotThrow(() => assertSupportedNode("24.0.0"));
});

test("bootstrap creates .env once and never overwrites user configuration", async () => {
  await withTemporaryProject(async (root) => {
    await writeFile(resolve(root, ".env.example"), "STEAMDT_API_KEY=\n", "utf8");
    assert.equal(await ensureEnvFile(root), true);
    assert.equal(await readFile(resolve(root, ".env"), "utf8"), "STEAMDT_API_KEY=\n");

    await writeFile(resolve(root, ".env"), "STEAMDT_API_KEY=user-value\n", "utf8");
    assert.equal(await ensureEnvFile(root), false);
    assert.equal(await readFile(resolve(root, ".env"), "utf8"), "STEAMDT_API_KEY=user-value\n");
  });
});

test("bootstrap installs dependencies only when the locked install is missing or stale", async () => {
  await withTemporaryProject(async (root) => {
    const lockfile = resolve(root, "package-lock.json");
    const installedLock = resolve(root, "node_modules", ".package-lock.json");
    await writeFile(lockfile, "{}", "utf8");
    assert.equal(await needsDependencyInstall(root), true);

    await mkdir(resolve(root, "node_modules"));
    await writeFile(installedLock, "{}", "utf8");
    for (const requiredPath of [
      ["node_modules", "typescript", "bin", "tsc"],
      ["node_modules", "tsx", "dist", "cli.mjs"],
      ["node_modules", "@modelcontextprotocol", "sdk", "package.json"],
    ]) {
      const path = resolve(root, ...requiredPath);
      await mkdir(resolve(path, ".."), { recursive: true });
      await writeFile(path, "{}", "utf8");
    }
    await utimes(lockfile, new Date(1_000), new Date(1_000));
    await utimes(installedLock, new Date(2_000), new Date(2_000));
    assert.equal(await needsDependencyInstall(root), false);

    await utimes(lockfile, new Date(3_000), new Date(3_000));
    assert.equal(await needsDependencyInstall(root), true);
  });
});

test("bootstrap rebuilds only when MCP output is missing or older than source", async () => {
  await withTemporaryProject(async (root) => {
    await mkdir(resolve(root, "src"), { recursive: true });
    await writeFile(resolve(root, "src", "index.ts"), "export {};\n", "utf8");
    await writeFile(resolve(root, "package.json"), "{}", "utf8");
    await writeFile(resolve(root, "package-lock.json"), "{}", "utf8");
    await writeFile(resolve(root, "tsconfig.json"), "{}", "utf8");
    assert.equal(await needsBuild(root), true);

    const output = resolve(root, "dist", "src", "mcp", "index.js");
    await mkdir(resolve(root, "dist", "src", "mcp"), { recursive: true });
    await writeFile(output, "export {};\n", "utf8");
    for (const input of [
      resolve(root, "src", "index.ts"),
      resolve(root, "package.json"),
      resolve(root, "package-lock.json"),
      resolve(root, "tsconfig.json"),
    ]) {
      await utimes(input, new Date(1_000), new Date(1_000));
    }
    await utimes(output, new Date(2_000), new Date(2_000));
    assert.equal(await needsBuild(root), false);

    await utimes(resolve(root, "src", "index.ts"), new Date(3_000), new Date(3_000));
    assert.equal(await needsBuild(root), true);
  });
});

test("bootstrap redirects child stdout and stderr away from MCP stdout", async () => {
  const sink = new PassThrough();
  let output = "";
  sink.setEncoding("utf8");
  sink.on("data", (chunk) => {
    output += chunk;
  });
  await runCommand(
    process.execPath,
    ["-e", "console.log('child-out'); console.error('child-error')"],
    { cwd: process.cwd(), label: "test child", timeoutMs: 10_000, stderr: sink },
  );
  assert.match(output, /child-out/);
  assert.match(output, /child-error/);
  assert.equal(npmExecutable("win32"), "npm.cmd");
  assert.equal(npmExecutable("linux"), "npm");
  const npm = await npmInvocation();
  assert.ok(npm.command.length > 0);
  if (process.platform === "win32") {
    assert.equal(npm.command, process.execPath);
    assert.match(npm.args[0], /npm-cli\.js$/i);
  }
});
