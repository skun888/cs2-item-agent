import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();

test("release template keeps all sensitive configuration values blank", () => {
  const template = readFileSync(resolve(repositoryRoot, ".env.example"), "utf8");
  const sensitiveVariables = [
    "STEAMDT_API_KEY",
    "CSQAQ_API_TOKEN",
    "STEAM_PROXY_URL",
    "WECHAT_WEBHOOK_URL",
  ];

  for (const variable of sensitiveVariables) {
    const definition = template.match(new RegExp(`^${variable}=(.*)$`, "m"));
    assert.ok(definition, `${variable} must remain documented in .env.example`);
    assert.equal(definition[1], "", `${variable} must remain blank in .env.example`);
  }
});

test("release baseline ignores secrets and user-owned runtime state", () => {
  const ignoreRules = new Set(
    readFileSync(resolve(repositoryRoot, ".gitignore"), "utf8")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );

  for (const requiredRule of [
    ".env",
    ".env.*",
    "!.env.example",
    "data/",
    ".local/",
    "tests/integration/private/",
  ]) {
    assert.ok(ignoreRules.has(requiredRule), `missing required .gitignore rule: ${requiredRule}`);
  }
});
