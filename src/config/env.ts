import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

import { AppError } from "../core/errors.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppConfig {
  readonly cwd: string;
  readonly dataDir: string;
  readonly databasePath: string;
  readonly steamDtApiKey?: string;
  readonly steamDtBaseUrl: string;
  readonly csQaqApiToken?: string;
  readonly csQaqBaseUrl: string;
  readonly steamCommunityBaseUrl: string;
  readonly steamProxyUrl?: string;
  readonly wechatWebhookUrl?: string;
  readonly feeTemplatePath?: string;
  readonly inventoryDefaultIntervalMinutes: number;
  readonly inventoryPriceCacheMinutes: number;
  readonly inventoryHighValueItemCny: number;
  readonly inventoryLargeChangeCny: number;
  readonly inventoryLargeChangeRate: number;
  readonly inventoryMinimumPriceCoverage: number;
  readonly alertDefaultIntervalMinutes: number;
  readonly logLevel: LogLevel;
}

export interface ReadConfigOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly loadDotEnv?: boolean;
}

const LOG_LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);

export function readConfig(options: ReadConfigOptions = {}): AppConfig {
  const cwd = resolve(options.cwd ?? process.cwd());
  const shouldLoadDotEnv = options.loadDotEnv ?? options.env === undefined;
  const dotEnvPath = resolve(cwd, ".env");

  if (shouldLoadDotEnv && existsSync(dotEnvPath)) {
    loadEnvFile(dotEnvPath);
  }

  const env = options.env ?? process.env;
  const rawDataDir = cleanOptional(env.CS2_ITEM_AGENT_DATA_DIR) ?? "./data";
  const dataDir = resolve(cwd, rawDataDir);
  const steamDtBaseUrl = parseHttpUrl(
    cleanOptional(env.STEAMDT_BASE_URL) ?? "https://open.steamdt.com",
    "STEAMDT_BASE_URL",
  );
  const csQaqBaseUrl = parseHttpUrl(
    cleanOptional(env.CSQAQ_BASE_URL) ?? "https://api.csqaq.com",
    "CSQAQ_BASE_URL",
  );
  const steamCommunityBaseUrl = parseHttpUrl(
    cleanOptional(env.STEAM_COMMUNITY_BASE_URL) ?? "https://steamcommunity.com",
    "STEAM_COMMUNITY_BASE_URL",
  );
  const inventoryDefaultIntervalMinutes = parsePositiveInteger(
    cleanOptional(env.INVENTORY_DEFAULT_INTERVAL_MINUTES) ?? "30",
    "INVENTORY_DEFAULT_INTERVAL_MINUTES",
  );
  const inventoryPriceCacheMinutes = parsePositiveInteger(
    cleanOptional(env.INVENTORY_PRICE_CACHE_MINUTES) ?? "30",
    "INVENTORY_PRICE_CACHE_MINUTES",
  );
  const inventoryHighValueItemCny = parseNonNegativeNumber(
    cleanOptional(env.INVENTORY_HIGH_VALUE_ITEM_CNY) ?? "1000",
    "INVENTORY_HIGH_VALUE_ITEM_CNY",
  );
  const inventoryLargeChangeCny = parseNonNegativeNumber(
    cleanOptional(env.INVENTORY_LARGE_CHANGE_CNY) ?? "10000",
    "INVENTORY_LARGE_CHANGE_CNY",
  );
  const inventoryLargeChangeRate = parseUnitRate(
    cleanOptional(env.INVENTORY_LARGE_CHANGE_RATE) ?? "0.20",
    "INVENTORY_LARGE_CHANGE_RATE",
  );
  const inventoryMinimumPriceCoverage = parseUnitRate(
    cleanOptional(env.INVENTORY_MINIMUM_PRICE_COVERAGE) ?? "0.90",
    "INVENTORY_MINIMUM_PRICE_COVERAGE",
  );
  const alertDefaultIntervalMinutes = parsePositiveInteger(
    cleanOptional(env.ALERT_DEFAULT_INTERVAL_MINUTES) ?? "30",
    "ALERT_DEFAULT_INTERVAL_MINUTES",
  );
  const rawSteamProxyUrl = cleanOptional(env.STEAM_PROXY_URL);
  const steamProxyUrl = rawSteamProxyUrl
    ? parseHttpUrl(rawSteamProxyUrl, "STEAM_PROXY_URL")
    : undefined;
  const logLevel = cleanOptional(env.LOG_LEVEL) ?? "info";
  const steamDtApiKey = cleanOptional(env.STEAMDT_API_KEY);
  const csQaqApiToken = cleanOptional(env.CSQAQ_API_TOKEN);
  const rawWechatWebhookUrl = cleanOptional(env.WECHAT_WEBHOOK_URL);
  const wechatWebhookUrl = rawWechatWebhookUrl
    ? parseHttpUrl(rawWechatWebhookUrl, "WECHAT_WEBHOOK_URL")
    : undefined;
  const rawFeeTemplatePath = cleanOptional(env.FEE_TEMPLATE_PATH);
  const feeTemplatePath = rawFeeTemplatePath ? resolve(cwd, rawFeeTemplatePath) : undefined;

  if (!LOG_LEVELS.has(logLevel as LogLevel)) {
    throw new AppError("CONFIG_ERROR", "LOG_LEVEL must be debug, info, warn, or error.");
  }

  return {
    cwd,
    dataDir,
    databasePath: resolve(dataDir, "cs2-item-agent.db"),
    steamDtBaseUrl,
    csQaqBaseUrl,
    steamCommunityBaseUrl,
    ...(steamProxyUrl ? { steamProxyUrl } : {}),
    inventoryDefaultIntervalMinutes,
    inventoryPriceCacheMinutes,
    inventoryHighValueItemCny,
    inventoryLargeChangeCny,
    inventoryLargeChangeRate,
    inventoryMinimumPriceCoverage,
    alertDefaultIntervalMinutes,
    logLevel: logLevel as LogLevel,
    ...(steamDtApiKey ? { steamDtApiKey } : {}),
    ...(csQaqApiToken ? { csQaqApiToken } : {}),
    ...(wechatWebhookUrl ? { wechatWebhookUrl } : {}),
    ...(feeTemplatePath ? { feeTemplatePath } : {}),
  };
}

export function requireSteamDtApiKey(config: AppConfig): string {
  if (!config.steamDtApiKey) {
    throw new AppError(
      "CONFIG_ERROR",
      "STEAMDT_API_KEY is required for this command. Copy .env.example to .env and add your key.",
    );
  }
  return config.steamDtApiKey;
}

export function requireCsQaqApiToken(config: AppConfig): string {
  if (!config.csQaqApiToken) {
    throw new AppError(
      "CONFIG_ERROR",
      "CSQAQ_API_TOKEN is required for this command. Add your personal token to the local .env file.",
    );
  }
  return config.csQaqApiToken;
}

function cleanOptional(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function parseHttpUrl(value: string, name: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new AppError("CONFIG_ERROR", `${name} must be a valid HTTP or HTTPS URL.`);
  }
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 10_080) {
    throw new AppError("CONFIG_ERROR", `${name} must be an integer from 1 to 10080.`);
  }
  return parsed;
}

function parseNonNegativeNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new AppError("CONFIG_ERROR", `${name} must be a non-negative number.`);
  }
  return parsed;
}

function parseUnitRate(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new AppError("CONFIG_ERROR", `${name} must be a decimal from 0 to 1.`);
  }
  return parsed;
}
