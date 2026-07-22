import { AppError } from "../../core/errors.js";
import { verifiedEvidence, type Evidence } from "../../domain/evidence.js";
import type {
  KlineQuery,
  SteamDtBatchPriceEntry,
  SteamDtApiEnvelope,
  SteamDtClientOptions,
  SteamDtKlinePoint,
  SteamDtPriceEntry,
  SteamDtInspectPreview,
} from "./types.js";

const DEFAULT_BASE_URL = "https://open.steamdt.com";

export class SteamDtClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: SteamDtClientOptions) {
    if (!options.apiKey.trim()) {
      throw new AppError("CONFIG_ERROR", "SteamDT API key cannot be empty.");
    }
    this.#apiKey = options.apiKey.trim();
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async getSinglePrice(marketHashName: string): Promise<Evidence<readonly SteamDtPriceEntry[]>> {
    const name = requireText(marketHashName, "marketHashName");
    const envelope = await this.#request<unknown>("/open/cs2/v1/price/single", {
      marketHashName: name,
    });
    const entries = parsePriceEntries(requireEnvelopeData(envelope));

    return verifiedEvidence("steamdt:price-single", this.#now(), entries, [
      "Prices and order quantities are platform snapshots, not guaranteed executable trades.",
      "The provider response does not prove buyer, seller, or item ownership.",
    ]);
  }

  async getBatchPrices(
    marketHashNames: readonly string[],
  ): Promise<Evidence<readonly SteamDtBatchPriceEntry[]>> {
    const names = [...new Set(marketHashNames.map((name) => name.trim()).filter(Boolean))];
    if (names.length === 0 || names.length > 100) {
      throw new AppError("USAGE_ERROR", "SteamDT batch price query requires 1 to 100 marketHashNames.");
    }
    const envelope = await this.#request<unknown>(
      "/open/cs2/v1/price/batch",
      {},
      { marketHashNames: names },
    );
    const entries = parseBatchPriceEntries(requireEnvelopeData(envelope));
    return verifiedEvidence("steamdt:price-batch", this.#now(), entries, [
      "Prices and order quantities are platform snapshots, not guaranteed executable trades.",
      "The batch endpoint is limited to one request per minute; callers should cache results.",
    ]);
  }

  async getBaseCatalog(): Promise<Evidence<unknown>> {
    const envelope = await this.#request<unknown>("/open/cs2/v1/base");
    return verifiedEvidence("steamdt:base", this.#now(), requireEnvelopeData(envelope), [
      "The catalog schema is retained at the adapter boundary until a real sanitized response is verified.",
    ]);
  }

  async getKline(query: KlineQuery): Promise<Evidence<readonly SteamDtKlinePoint[]>> {
    const envelope = await this.#request<unknown>(
      "/open/cs2/item/v1/kline",
      {},
      {
        marketHashName: requireText(query.marketHashName, "marketHashName"),
        platform: requireText(query.platform, "platform"),
        type: requireNonNegativeInteger(query.type, "type"),
        ...(query.specialStyle?.trim() ? { specialStyle: query.specialStyle.trim() } : {}),
      },
    );

    const points = parseKlinePoints(requireEnvelopeData(envelope));

    return verifiedEvidence("steamdt:item-kline", this.#now(), points, [
      "The meaning and history window of each K-line type must be reported from the actual response, not assumed globally.",
      "SteamDT K-line data does not by itself prove real transaction volume.",
    ]);
  }

  async getBroadKline(type: number): Promise<Evidence<readonly SteamDtKlinePoint[]>> {
    const envelope = await this.#request<unknown>(
      "/open/cs2/broad/v1/kline",
      {},
      { type: requireNonNegativeInteger(type, "type") },
    );
    const points = parseKlinePoints(requireEnvelopeData(envelope));
    return verifiedEvidence("steamdt:broad-kline", this.#now(), points, [
      "The broad-market index methodology is provider-defined.",
      "The meaning and history window of each K-line type must be reported from the actual response.",
    ]);
  }

  async generateInspectPreview(inspectUrl: string): Promise<Evidence<SteamDtInspectPreview>> {
    const envelope = await this.#request<unknown>(
      "/open/cs2/v1/inspect",
      {},
      { inspectUrl: requireText(inspectUrl, "inspectUrl") },
    );
    return verifiedEvidence("steamdt:inspect", this.#now(), parseInspectPreview(requireEnvelopeData(envelope)), [
      "The screenshot is rendered by SteamDT/CS2 from the supplied inspect payload.",
      "A non-sync response is a pending provider task and is not yet a finished image.",
    ]);
  }

  async getInspectWear(inspectUrl: string): Promise<Evidence<unknown>> {
    const envelope = await this.#request<unknown>(
      "/open/cs2/v1/wear",
      {},
      { inspectUrl: requireText(inspectUrl, "inspectUrl") },
    );
    return verifiedEvidence("steamdt:wear", this.#now(), requireEnvelopeData(envelope), [
      "This prerequisite resolves or registers the inspect payload before screenshot rendering.",
    ]);
  }

  async #request<T>(
    path: string,
    query: Readonly<Record<string, string>> = {},
    body?: Readonly<Record<string, unknown>>,
  ): Promise<SteamDtApiEnvelope<T>> {
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [name, value] of Object.entries(query)) {
      url.searchParams.set(name, value);
    }

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          "User-Agent": "cs2-item-agent/0.1",
        },
        signal: AbortSignal.timeout(this.#timeoutMs),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new AppError("HTTP_ERROR", "SteamDT request failed before a response was received.", {
        cause: error instanceof Error ? error.message : "unknown network error",
      });
    }

    if (!response.ok) {
      throw new AppError("HTTP_ERROR", `SteamDT returned HTTP ${response.status}.`, {
        status: response.status,
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AppError("CONTRACT_ERROR", "SteamDT returned invalid JSON.");
    }

    const envelope = parseEnvelope<T>(payload);
    if (!envelope.success) {
      throw new AppError("PROVIDER_ERROR", envelope.errorMessage ?? "SteamDT reported an error.", {
        ...(envelope.errorCode !== undefined ? { providerCode: envelope.errorCode } : {}),
      });
    }
    return envelope;
  }
}

function parseEnvelope<T>(value: unknown): SteamDtApiEnvelope<T> {
  if (!isRecord(value) || typeof value.success !== "boolean") {
    throw new AppError("CONTRACT_ERROR", "SteamDT response is missing a boolean success field.");
  }

  const errorCode = value.errorCode ?? value.code;
  const errorMessage = value.errorMessage ?? value.errorMsg ?? value.message ?? value.msg;

  return {
    success: value.success,
    raw: value,
    ...(value.data !== undefined ? { data: value.data as T } : {}),
    ...(typeof errorCode === "string" || typeof errorCode === "number" ? { errorCode } : {}),
    ...(typeof errorMessage === "string" ? { errorMessage } : {}),
  };
}

function requireEnvelopeData<T>(envelope: SteamDtApiEnvelope<T>): T {
  if (envelope.data === undefined) {
    throw new AppError("CONTRACT_ERROR", "SteamDT success response is missing data.");
  }
  return envelope.data;
}

function parseBatchPriceEntries(value: unknown): readonly SteamDtBatchPriceEntry[] {
  if (!Array.isArray(value)) {
    throw new AppError("CONTRACT_ERROR", "SteamDT batch price data must be an array.");
  }
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.marketHashName !== "string" || !entry.marketHashName.trim()) {
      throw new AppError("CONTRACT_ERROR", "SteamDT batch price item is missing marketHashName.");
    }
    return {
      marketHashName: entry.marketHashName.trim(),
      dataList: parsePriceEntries(entry.dataList),
    };
  });
}

function parsePriceEntries(value: unknown): readonly SteamDtPriceEntry[] {
  if (!Array.isArray(value)) {
    throw new AppError("CONTRACT_ERROR", "SteamDT price data must be an array.");
  }

  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.platform !== "string") {
      throw new AppError("CONTRACT_ERROR", "SteamDT price entry is missing platform.", { index });
    }

    return {
      platform: entry.platform,
      raw: entry,
      ...optionalString(entry, "platformItemId"),
      ...optionalNumber(entry, "sellPrice"),
      ...optionalNumber(entry, "sellCount"),
      ...optionalNumber(entry, "biddingPrice"),
      ...optionalNumber(entry, "biddingCount"),
      ...optionalNumber(entry, "updateTime"),
    };
  });
}

function parseKlinePoints(value: unknown): readonly SteamDtKlinePoint[] {
  if (!Array.isArray(value)) {
    throw new AppError("CONTRACT_ERROR", "SteamDT K-line data must be an array.");
  }

  return value.map((point, index) => {
    if (!Array.isArray(point) || point.length !== 5) {
      throw new AppError("CONTRACT_ERROR", "SteamDT K-line point must contain five values.", {
        index,
      });
    }
    const timestamp = parseFiniteNumber(point[0], `K-line timestamp at index ${index}`);
    const open = parseFiniteNumber(point[1], `K-line open at index ${index}`);
    const close = parseFiniteNumber(point[2], `K-line close at index ${index}`);
    const high = parseFiniteNumber(point[3], `K-line high at index ${index}`);
    const low = parseFiniteNumber(point[4], `K-line low at index ${index}`);
    const raw = [point[0] as string | number, open, close, high, low] as const;
    return { timestamp, open, close, high, low, raw };
  });
}

function parseInspectPreview(value: unknown): SteamDtInspectPreview {
  if (!isRecord(value)) throw new AppError("CONTRACT_ERROR", "SteamDT inspect data must be an object.");
  const screenshot = isRecord(value.screenshot) ? value.screenshot : {};
  const screenshots = isRecord(screenshot.screenshots) ? screenshot.screenshots : {};
  return {
    sync: value.sync === true,
    success: value.success === true,
    ...optionalTextValue(value.taskId, "taskId"),
    ...optionalTextValue(screenshot.fingerprint, "fingerprint"),
    screenshots: {
      front: parseUrlArray(screenshots.front),
      back: parseUrlArray(screenshots.back),
      detail: parseUrlArray(screenshots.detail),
    },
    ...(typeof screenshot.existSticker === "boolean" ? { existSticker: screenshot.existSticker } : {}),
    ...optionalTextValue(screenshot.protoEncodeStr, "protoEncodeStr"),
  };
}

function parseUrlArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && /^https?:\/\//.test(entry))
    : [];
}

function optionalTextValue<K extends string>(value: unknown, key: K): Partial<Record<K, string>> {
  return typeof value === "string" && value.trim() ? ({ [key]: value.trim() } as Record<K, string>) : {};
}

function optionalString(
  record: Readonly<Record<string, unknown>>,
  key: "platformItemId",
): Partial<Pick<SteamDtPriceEntry, "platformItemId">> {
  const value = record[key];
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "string" && typeof value !== "number") {
    throw new AppError("CONTRACT_ERROR", `SteamDT field ${key} must be a string or number.`);
  }
  return { [key]: String(value) };
}

function optionalNumber<K extends keyof SteamDtPriceEntry>(
  record: Readonly<Record<string, unknown>>,
  key: K,
): Partial<Pick<SteamDtPriceEntry, K>> {
  const value = record[key as string];
  if (value === undefined || value === null || value === "") return {};
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AppError("CONTRACT_ERROR", `SteamDT field ${String(key)} must be numeric.`);
  }
  return { [key]: parsed } as Partial<Pick<SteamDtPriceEntry, K>>;
}

function requireText(value: string, name: string): string {
  const cleaned = value.trim();
  if (!cleaned) throw new AppError("USAGE_ERROR", `${name} cannot be empty.`);
  return cleaned;
}

function parseFiniteNumber(value: unknown, name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AppError("CONTRACT_ERROR", `${name} must be numeric.`);
  }
  return parsed;
}

function requireNonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new AppError("USAGE_ERROR", `${name} must be a non-negative integer.`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
