import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chdir } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const MINIMUM_NODE_MAJOR = 24;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bootstrapDirectory = ".local";
const bootstrapLock = "mcp-bootstrap.lock";

function writeDiagnostic(message) {
  process.stderr.write(`[cs2-item-agent] ${message}\n`);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function safeStat(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function parseNodeMajor(version) {
  const match = /^(?:v)?(\d+)(?:\.|$)/.exec(version);
  return match ? Number.parseInt(match[1], 10) : Number.NaN;
}

export function assertSupportedNode(version = process.versions.node) {
  const major = parseNodeMajor(version);
  if (!Number.isInteger(major) || major < MINIMUM_NODE_MAJOR) {
    throw new Error(
      `Node.js ${MINIMUM_NODE_MAJOR} or newer is required; current version is ${version}. ` +
        "Install or select Node.js 24, then reopen the project.",
    );
  }
}

export async function ensureEnvFile(root) {
  const examplePath = resolve(root, ".env.example");
  const envPath = resolve(root, ".env");
  if (!(await exists(examplePath))) {
    throw new Error(".env.example is missing; cannot create the local configuration file.");
  }

  try {
    await copyFile(examplePath, envPath, constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

export async function needsDependencyInstall(root) {
  const lockfile = await safeStat(resolve(root, "package-lock.json"));
  if (!lockfile) throw new Error("package-lock.json is missing; reproducible npm ci is unavailable.");

  const installedLock = await safeStat(resolve(root, "node_modules", ".package-lock.json"));
  if (!installedLock) return true;
  for (const requiredPath of [
    ["node_modules", "typescript", "bin", "tsc"],
    ["node_modules", "tsx", "dist", "cli.mjs"],
    ["node_modules", "@modelcontextprotocol", "sdk", "package.json"],
  ]) {
    if (!(await exists(resolve(root, ...requiredPath)))) return true;
  }
  return lockfile.mtimeMs > installedLock.mtimeMs + 1;
}

async function collectTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTypeScriptFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

export async function needsBuild(root) {
  const output = await safeStat(resolve(root, "dist", "src", "mcp", "index.js"));
  if (!output) return true;

  const inputs = [
    resolve(root, "package.json"),
    resolve(root, "package-lock.json"),
    resolve(root, "tsconfig.json"),
    ...(await collectTypeScriptFiles(resolve(root, "src"))),
  ];
  for (const input of inputs) {
    const inputStat = await stat(input);
    if (inputStat.mtimeMs > output.mtimeMs + 1) return true;
  }
  return false;
}

export function npmExecutable(platform = process.platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

export async function npmInvocation({
  platform = process.platform,
  execPath = process.execPath,
  npmExecPath = process.env.npm_execpath,
} = {}) {
  if (platform !== "win32") return { command: npmExecutable(platform), args: [] };

  const candidates = [npmExecPath, resolve(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js")]
    .filter((candidate) => typeof candidate === "string" && /\.(?:c?js|mjs)$/i.test(candidate));
  for (const candidate of candidates) {
    if (await exists(candidate)) return { command: execPath, args: [candidate] };
  }
  throw new Error("npm-cli.js was not found beside Node.js. Reinstall Node.js 24 with npm included.");
}

export async function runCommand(
  command,
  args,
  { cwd, label, timeoutMs, stderr = process.stderr, stdout = stderr },
) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (stdout === "ignore") child.stdout.resume();
    else child.stdout.pipe(stdout, { end: false });
    child.stderr.pipe(stderr, { end: false });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${label} could not start: ${error.message}`, { cause: error }));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${label} timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`));
      } else if (code !== 0) {
        reject(new Error(`${label} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`));
      } else {
        resolvePromise();
      }
    });
  });
}

async function lockOwnerIsAlive(lockPath) {
  try {
    const content = JSON.parse(await readFile(lockPath, "utf8"));
    if (!Number.isInteger(content.pid) || content.pid <= 0) return false;
    process.kill(content.pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EPERM") return true;
    return false;
  }
}

async function acquireBootstrapLock(root, timeoutMs = 10 * 60 * 1000) {
  const directory = resolve(root, bootstrapDirectory);
  const lockPath = resolve(directory, bootstrapLock);
  await mkdir(directory, { recursive: true });
  const startedAt = Date.now();

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return async () => {
        await handle.close();
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
        throw error;
      }

      const lockStat = await safeStat(lockPath);
      const lockAgeMs = lockStat ? Date.now() - lockStat.mtimeMs : 0;
      const stale = lockStat && lockAgeMs > 20 * 60 * 1000;
      const ownerMissing = lockStat && lockAgeMs > 5_000 && !(await lockOwnerIsAlive(lockPath));
      if (stale || ownerMissing) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error("Timed out waiting for another CS2 Item Agent bootstrap process.");
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
}

export async function prepareProject(root = projectRoot) {
  assertSupportedNode();
  chdir(root);
  const releaseLock = await acquireBootstrapLock(root);
  try {
    const envCreated = await ensureEnvFile(root);
    if (envCreated) {
      writeDiagnostic("Created .env from .env.example. Add your API keys locally, then restart MCP.");
    }

    if (await needsDependencyInstall(root)) {
      writeDiagnostic("Installing locked dependencies for the first run...");
      const npm = await npmInvocation();
      await runCommand(npm.command, [...npm.args, "ci", "--no-audit", "--no-fund"], {
        cwd: root,
        label: "npm ci",
        timeoutMs: 10 * 60 * 1000,
      });
    }

    if (await needsBuild(root)) {
      writeDiagnostic("Building the local MCP server...");
      const npm = await npmInvocation();
      await runCommand(npm.command, [...npm.args, "run", "build"], {
        cwd: root,
        label: "npm run build",
        timeoutMs: 5 * 60 * 1000,
      });
    }

    writeDiagnostic("Applying local database migrations...");
    await runCommand(process.execPath, ["dist/src/cli/index.js", "db", "migrate"], {
      cwd: root,
      label: "database migration",
      timeoutMs: 60 * 1000,
      stdout: "ignore",
    });
  } finally {
    await releaseLock();
  }
}

export async function runMcp(root = projectRoot) {
  await prepareProject(root);
  await import(pathToFileURL(resolve(root, "dist", "src", "mcp", "index.js")).href);
}

async function main() {
  const prepareOnly = process.argv.slice(2).includes("--prepare-only");
  if (prepareOnly) await prepareProject(projectRoot);
  else await runMcp(projectRoot);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    writeDiagnostic(`Startup failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
