import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { chdir } from "node:process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
chdir(projectRoot);
await import(pathToFileURL(resolve(projectRoot, "dist/src/mcp/index.js")).href);
