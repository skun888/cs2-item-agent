import assert from "node:assert/strict";
import test from "node:test";

import { readConfig, requireCsQaqApiToken, requireSteamDtApiKey } from "../src/config/env.js";
import { AppError } from "../src/core/errors.js";

test("config uses safe local defaults and keeps SteamDT optional for health checks", () => {
  const config = readConfig({
    cwd: "C:/synthetic-project",
    env: {},
    loadDotEnv: false,
  });

  assert.match(config.databasePath.replaceAll("\\", "/"), /synthetic-project\/data\/cs2-item-agent\.db$/);
  assert.equal(config.steamDtApiKey, undefined);
  assert.equal(config.csQaqApiToken, undefined);
  assert.equal(config.csQaqBaseUrl, "https://api.csqaq.com");
  assert.equal(config.steamCommunityBaseUrl, "https://steamcommunity.com");
  assert.equal(config.steamProxyUrl, undefined);
  assert.equal(config.inventoryDefaultIntervalMinutes, 30);
  assert.equal(config.inventoryPriceCacheMinutes, 30);
  assert.equal(config.inventoryHighValueItemCny, 1_000);
  assert.equal(config.inventoryLargeChangeCny, 10_000);
  assert.equal(config.inventoryLargeChangeRate, 0.2);
  assert.equal(config.inventoryMinimumPriceCoverage, 0.9);
  assert.equal(config.alertDefaultIntervalMinutes, 30);
  assert.throws(
    () => requireSteamDtApiKey(config),
    (error: unknown) => error instanceof AppError && error.code === "CONFIG_ERROR",
  );
  assert.throws(
    () => readConfig({
      cwd: "C:/synthetic-project",
      env: { INVENTORY_LARGE_CHANGE_RATE: "20" },
      loadDotEnv: false,
    }),
    (error: unknown) => error instanceof AppError && error.code === "CONFIG_ERROR",
  );
  assert.throws(
    () => requireCsQaqApiToken(config),
    (error: unknown) => error instanceof AppError && error.code === "CONFIG_ERROR",
  );
});

test("config validates inventory interval and webhook URLs", () => {
  assert.throws(
    () =>
      readConfig({
        cwd: "C:/synthetic-project",
        env: { INVENTORY_DEFAULT_INTERVAL_MINUTES: "0" },
        loadDotEnv: false,
      }),
    (error: unknown) => error instanceof AppError && error.code === "CONFIG_ERROR",
  );
  assert.throws(
    () =>
      readConfig({
        cwd: "C:/synthetic-project",
        env: { ALERT_DEFAULT_INTERVAL_MINUTES: "0" },
        loadDotEnv: false,
      }),
    (error: unknown) => error instanceof AppError && error.code === "CONFIG_ERROR",
  );
  assert.throws(
    () =>
      readConfig({
        cwd: "C:/synthetic-project",
        env: { WECHAT_WEBHOOK_URL: "file:///secret" },
        loadDotEnv: false,
      }),
    (error: unknown) => error instanceof AppError && error.code === "CONFIG_ERROR",
  );
});

test("config rejects non-http provider URLs", () => {
  assert.throws(
    () =>
      readConfig({
        cwd: "C:/synthetic-project",
        env: { STEAMDT_BASE_URL: "file:///secret" },
        loadDotEnv: false,
      }),
    (error: unknown) => error instanceof AppError && error.code === "CONFIG_ERROR",
  );
  assert.throws(
    () =>
      readConfig({
        cwd: "C:/synthetic-project",
        env: { CSQAQ_BASE_URL: "file:///secret" },
        loadDotEnv: false,
      }),
    (error: unknown) => error instanceof AppError && error.code === "CONFIG_ERROR",
  );
});
