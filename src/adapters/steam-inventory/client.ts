import { AppError } from "../../core/errors.js";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { createHash } from "node:crypto";
import type {
  InventoryFetchStatus,
  SteamInventoryAsset,
  SteamInventoryClientOptions,
  SteamInventoryFetchResult,
} from "./types.js";

const SOURCE = "steam-community:public-inventory" as const;
const STEAM_ID64_MIN = 76_561_197_960_265_728n;

export class SteamInventoryClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  readonly #pageSize: number;
  readonly #maxPages: number;

  constructor(options: SteamInventoryClientOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? "https://steamcommunity.com").replace(/\/$/, "");
    this.#fetch = options.fetchFn ?? createFetch(options.proxyUrl);
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#pageSize = options.pageSize ?? 2_000;
    this.#maxPages = options.maxPages ?? 50;
  }

  async getCs2Inventory(steamId: string): Promise<SteamInventoryFetchResult> {
    validateSteamId64(steamId);
    const observedAt = this.#now().toISOString();
    const assets: SteamInventoryAsset[] = [];
    const seen = new Set<string>();
    let startAssetId: string | undefined;
    let totalInventoryCount: number | undefined;

    for (let page = 1; page <= this.#maxPages; page += 1) {
      const pageResult = await this.#fetchPage(steamId, startAssetId);
      if (pageResult.kind === "status") {
        return statusResult(steamId, observedAt, pageResult.status, page - 1, pageResult);
      }

      if (pageResult.totalInventoryCount !== undefined) {
        totalInventoryCount = pageResult.totalInventoryCount;
      }
      for (const asset of pageResult.assets) {
        if (seen.has(asset.assetId)) continue;
        seen.add(asset.assetId);
        assets.push(asset);
      }

      if (!pageResult.moreItems) {
        return {
          source: SOURCE,
          steamId,
          observedAt,
          status: "public",
          httpStatus: 200,
          assets,
          ...(totalInventoryCount !== undefined ? { totalInventoryCount } : {}),
          pageCount: page,
          complete: true,
        };
      }
      if (!pageResult.lastAssetId || pageResult.lastAssetId === startAssetId) {
        return statusResult(steamId, observedAt, "temporary_failure", page, {
          httpStatus: 200,
          message: "Steam pagination did not provide a new last_assetid.",
        });
      }
      startAssetId = pageResult.lastAssetId;
    }

    return statusResult(steamId, observedAt, "temporary_failure", this.#maxPages, {
      httpStatus: 200,
      message: `Steam inventory exceeded the safe pagination limit of ${this.#maxPages}.`,
    });
  }

  async #fetchPage(
    steamId: string,
    startAssetId: string | undefined,
  ): Promise<InventoryPage | InventoryStatusPage> {
    const url = new URL(`${this.#baseUrl}/inventory/${steamId}/730/2`);
    url.searchParams.set("l", "schinese");
    url.searchParams.set("count", String(this.#pageSize));
    if (startAssetId) url.searchParams.set("start_assetid", startAssetId);

    const responseResult = await this.#fetchWithRetry(url);
    if (responseResult.kind === "status") {
      return {
        kind: "status",
        status: "temporary_failure",
        message: responseResult.message,
      };
    }
    const response = responseResult.response;

    if (response.status === 401 || response.status === 403) {
      return {
        kind: "status",
        status: "private_or_unavailable",
        httpStatus: response.status,
        message: "Steam inventory is private, friends-only, or unavailable to this public request.",
      };
    }
    if (response.status === 429) {
      return {
        kind: "status",
        status: "rate_limited",
        httpStatus: response.status,
        message: "Steam rate-limited the public inventory request.",
      };
    }
    if (!response.ok) {
      return {
        kind: "status",
        status: "temporary_failure",
        httpStatus: response.status,
        message: `Steam public inventory returned HTTP ${response.status}.`,
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return {
        kind: "status",
        status: "temporary_failure",
        httpStatus: response.status,
        message: "Steam returned a non-JSON inventory response.",
      };
    }
    return parseInventoryPage(payload, steamId);
  }

  async #fetchWithRetry(
    url: URL,
  ): Promise<{ readonly kind: "response"; readonly response: Response } | InventoryStatusPage> {
    let lastMessage = "Steam request failed.";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.#fetch(url, {
          headers: { Accept: "application/json", "User-Agent": "cs2-item-agent/0.8.0-alpha.1" },
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
        if (response.status >= 500 && attempt === 0) {
          await delay(250);
          continue;
        }
        return { kind: "response", response };
      } catch (error) {
        lastMessage = error instanceof Error ? `Steam request failed: ${error.message}` : "Steam request failed.";
        if (attempt === 0) await delay(250);
      }
    }
    return { kind: "status", status: "temporary_failure", message: lastMessage };
  }
}

interface InventoryPage {
  readonly kind: "inventory";
  readonly assets: readonly SteamInventoryAsset[];
  readonly totalInventoryCount?: number;
  readonly moreItems: boolean;
  readonly lastAssetId?: string;
}

interface InventoryStatusPage {
  readonly kind: "status";
  readonly status: Exclude<InventoryFetchStatus, "public">;
  readonly httpStatus?: number;
  readonly message: string;
}

function parseInventoryPage(payload: unknown, steamId: string): InventoryPage | InventoryStatusPage {
  const record = asRecord(payload);
  if (!record) return contractFailure("Steam inventory response was not an object.");

  if (record.success !== 1 && record.success !== true) {
    const message = typeof record.Error === "string" ? record.Error : "Steam inventory response reported failure.";
    const privateLike = /private|inventory.*unavailable|权限|隐私/i.test(message);
    return {
      kind: "status",
      status: privateLike ? "private_or_unavailable" : "temporary_failure",
      httpStatus: 200,
      message,
    };
  }

  const rawAssets = record.assets;
  const rawDescriptions = record.descriptions;
  if (rawAssets !== undefined && !Array.isArray(rawAssets)) {
    return contractFailure("Steam inventory assets field was not an array.");
  }
  if (rawDescriptions !== undefined && !Array.isArray(rawDescriptions)) {
    return contractFailure("Steam inventory descriptions field was not an array.");
  }
  if (record.asset_properties !== undefined && !Array.isArray(record.asset_properties)) {
    return contractFailure("Steam inventory asset_properties field was not an array.");
  }

  const descriptions = new Map<string, Readonly<Record<string, unknown>>>();
  for (const raw of rawDescriptions ?? []) {
    const description = asRecord(raw);
    if (!description) continue;
    const classId = asString(description.classid);
    const instanceId = asString(description.instanceid) ?? "0";
    if (classId) descriptions.set(`${classId}:${instanceId}`, description);
  }
  const propertiesByAssetId = new Map<string, Readonly<Record<string, unknown>>>();
  for (const raw of Array.isArray(record.asset_properties) ? record.asset_properties : []) {
    const entry = asRecord(raw);
    const assetId = entry ? asString(entry.assetid) : undefined;
    if (assetId && Array.isArray(entry?.asset_properties)) {
      propertiesByAssetId.set(assetId, entry);
    }
  }

  const assets: SteamInventoryAsset[] = [];
  for (const raw of rawAssets ?? []) {
    const asset = asRecord(raw);
    if (!asset) return contractFailure("Steam inventory contained an invalid asset.");
    const assetId = asString(asset.assetid);
    const classId = asString(asset.classid);
    const instanceId = asString(asset.instanceid) ?? "0";
    const contextId = asString(asset.contextid) ?? "2";
    const amount = toPositiveInteger(asset.amount) ?? 1;
    if (!assetId || !classId) {
      return contractFailure("Steam inventory asset lacked assetid or classid.");
    }
    const description = descriptions.get(`${classId}:${instanceId}`) ?? {};
    const marketHashName = asString(description.market_hash_name);
    const propertyEntry = propertiesByAssetId.get(assetId);
    const properties = Array.isArray(propertyEntry?.asset_properties)
      ? propertyEntry.asset_properties
      : [];
    const paintSeed = readIntegerProperty(properties, 1);
    const paintWear = readFloatProperty(properties, 2);
    const charmTemplate = readIntegerProperty(properties, 3);
    const nameTag = readStringProperty(properties, 5);
    const itemCertificate = readStringProperty(properties, 6);
    const paintIndex = readIntegerProperty(properties, 7);
    const paintWearBits = paintWear !== undefined ? float32Bits(paintWear) : undefined;
    const observationFingerprint =
      paintSeed !== undefined && paintWearBits !== undefined
        ? createObservationFingerprint({
            classId,
            instanceId,
            ...(marketHashName ? { marketHashName } : {}),
            paintSeed,
            paintWearBits,
            ...(paintIndex !== undefined ? { paintIndex } : {}),
          })
        : undefined;
    const inspectTemplate = findInspectLink(description.actions);
    const inspectLink = inspectTemplate
      ? resolveInspectLink(inspectTemplate, steamId, assetId, properties)
      : undefined;
    const displayName = asString(description.market_name) ?? asString(description.name);
    const itemType = asString(description.type);
    const icon = asString(description.icon_url);
    const tradable = toBoolean(description.tradable);
    const marketable = toBoolean(description.marketable);
    const commodity = toBoolean(description.commodity);

    assets.push({
      assetId,
      classId,
      instanceId,
      contextId,
      amount,
      ...(marketHashName ? { marketHashName } : {}),
      ...(displayName ? { displayName } : {}),
      ...(itemType ? { itemType } : {}),
      ...(tradable !== undefined ? { tradable } : {}),
      ...(marketable !== undefined ? { marketable } : {}),
      ...(commodity !== undefined ? { commodity } : {}),
      ...(inspectLink ? { inspectLink } : {}),
      ...(icon ? { iconUrl: `https://community.cloudflare.steamstatic.com/economy/image/${icon}` } : {}),
      ...(paintSeed !== undefined ? { paintSeed } : {}),
      ...(paintWear !== undefined ? { paintWear } : {}),
      ...(paintWearBits !== undefined ? { paintWearBits } : {}),
      ...(paintIndex !== undefined ? { paintIndex } : {}),
      ...(nameTag ? { nameTag } : {}),
      ...(charmTemplate !== undefined ? { charmTemplate } : {}),
      ...(itemCertificate ? { itemCertificate } : {}),
      ...(observationFingerprint ? { observationFingerprint } : {}),
      raw: { asset, description, ...(propertyEntry ? { assetProperties: propertyEntry } : {}) },
    });
  }

  const totalInventoryCount = toNonNegativeInteger(record.total_inventory_count);
  const moreItems = record.more_items === true || record.more_items === 1;
  const lastAssetId = asString(record.last_assetid);
  return {
    kind: "inventory",
    assets,
    ...(totalInventoryCount !== undefined ? { totalInventoryCount } : {}),
    moreItems,
    ...(lastAssetId ? { lastAssetId } : {}),
  };
}

function contractFailure(message: string): InventoryStatusPage {
  return { kind: "status", status: "temporary_failure", httpStatus: 200, message };
}

function statusResult(
  steamId: string,
  observedAt: string,
  status: Exclude<InventoryFetchStatus, "public">,
  pageCount: number,
  details: { readonly httpStatus?: number; readonly message: string },
): SteamInventoryFetchResult {
  return {
    source: SOURCE,
    steamId,
    observedAt,
    status,
    ...(details.httpStatus !== undefined ? { httpStatus: details.httpStatus } : {}),
    message: details.message,
    assets: [],
    pageCount,
    complete: false,
  };
}

export function validateSteamId64(steamId: string): void {
  if (!/^\d{17}$/.test(steamId) || BigInt(steamId) < STEAM_ID64_MIN) {
    throw new AppError("USAGE_ERROR", "SteamID must be a valid 17-digit SteamID64.");
  }
}

function findInspectLink(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const raw of value) {
    const action = asRecord(raw);
    const link = action ? asString(action.link) : undefined;
    if (link?.startsWith("steam://rungame/730/")) return link;
  }
  return undefined;
}

function resolveInspectLink(
  template: string,
  steamId: string,
  assetId: string,
  properties: readonly unknown[],
): string | undefined {
  const values = new Map<number, string>();
  for (const raw of properties) {
    const property = asRecord(raw);
    if (!property) continue;
    const propertyId = toNonNegativeInteger(property.propertyid);
    if (propertyId === undefined) continue;
    const value = asString(property.string_value)
      ?? asString(property.int_value)
      ?? asString(property.float_value);
    if (value !== undefined) values.set(propertyId, value);
  }
  const resolved = template
    .replaceAll("%owner_steamid%", steamId)
    .replaceAll("%assetid%", assetId)
    .replace(/%propid:(\d+)%/g, (placeholder, id: string) => values.get(Number(id)) ?? placeholder);
  return /%(?:owner_steamid|assetid|propid:\d+)%/.test(resolved) ? undefined : resolved;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function toBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return undefined;
}

function toPositiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function toNonNegativeInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function readIntegerProperty(properties: readonly unknown[], propertyId: number): number | undefined {
  const property = findProperty(properties, propertyId);
  if (!property) return undefined;
  const parsed = Number(property.int_value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function readFloatProperty(properties: readonly unknown[], propertyId: number): number | undefined {
  const property = findProperty(properties, propertyId);
  if (!property) return undefined;
  const parsed = Number(property.float_value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readStringProperty(properties: readonly unknown[], propertyId: number): string | undefined {
  const property = findProperty(properties, propertyId);
  return property ? asString(property.string_value) : undefined;
}

function findProperty(
  properties: readonly unknown[],
  propertyId: number,
): Readonly<Record<string, unknown>> | undefined {
  return properties
    .map(asRecord)
    .find((property) => Number(property?.propertyid) === propertyId);
}

function float32Bits(value: number): number {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}

function createObservationFingerprint(input: {
  readonly classId: string;
  readonly instanceId: string;
  readonly marketHashName?: string;
  readonly paintSeed: number;
  readonly paintWearBits: number;
  readonly paintIndex?: number;
}): string {
  const canonical = [
    "cs2-observation-v1",
    input.classId,
    input.instanceId,
    input.marketHashName ?? "unknown-market-hash-name",
    input.paintIndex ?? "unknown-paint-index",
    input.paintWearBits,
    input.paintSeed,
  ].join(":");
  return `cs2obs:v1:${createHash("sha256").update(canonical).digest("hex")}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createFetch(proxyUrl: string | undefined): typeof fetch {
  if (!proxyUrl) return fetch;
  const dispatcher = new ProxyAgent(proxyUrl);
  return ((input: string | URL | Request, init?: RequestInit) =>
    undiciFetch(input as string | URL, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    }) as unknown as Promise<Response>) as typeof fetch;
}
