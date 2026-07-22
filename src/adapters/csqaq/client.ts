import { AppError } from "../../core/errors.js";
import { verifiedEvidence, type Evidence } from "../../domain/evidence.js";
import {
  normalizeCsQaqPersonalPriceData,
  type NormalizedMarketQuote,
} from "../../domain/market-quote.js";
import type {
  CsQaqAuditProbeResult,
  CsQaqAuditStatus,
  CsQaqClientOptions,
  CsQaqCaseCountEntry,
  CsQaqCaseRoiEntry,
  CsQaqCollection,
  CsQaqCollectionItem,
  CsQaqDataShape,
  CsQaqHangingEntry,
  CsQaqHangingQuery,
  CsQaqMarketHomeData,
  CsQaqSectorKlinePoint,
  CsQaqHolderRankEntry,
  CsQaqItemIdentity,
  CsQaqItemIdentityPage,
  CsQaqItemDetail,
  CsQaqProbeSpec,
  CsQaqSupplyPoint,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.csqaq.com";

export class CsQaqClient {
  readonly baseUrl: string;
  readonly #apiToken: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #minimumRequestIntervalMs: number;
  readonly #delay: (milliseconds: number) => Promise<void>;
  #lastRequestStartedAt = 0;

  constructor(options: CsQaqClientOptions) {
    if (!options.apiToken.trim()) {
      throw new AppError("CONFIG_ERROR", "CSQAQ API token cannot be empty.");
    }
    this.#apiToken = options.apiToken.trim();
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#minimumRequestIntervalMs = options.minimumRequestIntervalMs ?? 1_100;
    this.#delay = options.delayImpl ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async searchItemIdentities(search: string): Promise<Evidence<readonly CsQaqItemIdentity[]>> {
    const evidence = await this.searchItemIdentityPage(search, 1, 50);
    return verifiedEvidence("csqaq:item-identities", new Date(evidence.observedAt), evidence.data.items, [
      "Search results are the provider catalog, not proof that an item is currently listed or held.",
    ]);
  }

  async searchItemIdentityPage(
    search: string,
    pageIndex = 1,
    pageSize = 50,
  ): Promise<Evidence<CsQaqItemIdentityPage>> {
    const name = requireText(search, "search");
    const observedAt = this.#now();
    const data = await this.#requestData("/api/v1/info/get_good_id", "POST", {
      page_index: requirePositiveInteger(pageIndex, "pageIndex"),
      page_size: requirePositiveInteger(pageSize, "pageSize"),
      search: name,
    });
    return verifiedEvidence("csqaq:item-identity-page", observedAt, parseItemIdentityPage(data), [
      "Catalog search is provider-scoped and paginated; an imported subset is not the complete CS2 catalog.",
    ]);
  }

  async getItemDetail(goodId: string): Promise<Evidence<CsQaqItemDetail>> {
    const id = requireText(goodId, "goodId");
    const observedAt = this.#now();
    const data = await this.#requestData("/api/v1/info/good", "GET", undefined, { id });
    return verifiedEvidence("csqaq:item-detail", observedAt, parseItemDetail(data), [
      "Image, type, rarity, exterior, and prices use CSQAQ's current catalog and refresh schedule.",
      "Remote images remain third-party assets and are cached only in the user's local data directory.",
    ]);
  }

  async getHolderRanking(goodId: string): Promise<Evidence<readonly CsQaqHolderRankEntry[]>> {
    const id = requireText(goodId, "goodId");
    const observedAt = this.#now();
    const data = await this.#requestData("/api/v1/monitor/rank", "POST", { good_id: id });
    return verifiedEvidence("csqaq:monitored-holder-ranking", observedAt, parseHolderRanking(data), [
      "The ranking covers only Steam accounts monitored by CSQAQ; it is not a complete global holder ranking.",
      "A public inventory observation does not prove beneficial ownership or a completed trade.",
    ]);
  }

  async getSupplyTrend(goodId: string): Promise<Evidence<readonly CsQaqSupplyPoint[]>> {
    const id = requireText(goodId, "goodId");
    const observedAt = this.#now();
    const data = await this.#requestData("/api/v1/info/good/statistic", "GET", undefined, { id });
    return verifiedEvidence("csqaq:item-supply-180d", observedAt, parseSupplyTrend(data), [
      "Supply is provider-defined observed survival quantity and can differ from the true global item count.",
      "The documented history window is approximately 180 days.",
    ]);
  }

  async getHangingCandidates(
    query: CsQaqHangingQuery,
  ): Promise<Evidence<readonly CsQaqHangingEntry[]>> {
    const observedAt = this.#now();
    const targetBalance = query.targetBalance ?? "steam";
    const data = await this.#requestData("/api/v1/info/exchange_detail", "POST", {
      page_index: requirePositiveInteger(query.pageIndex ?? 1, "pageIndex"),
      res: targetBalance === "steam" ? 0 : 1,
      platforms: query.sourcePlatforms ?? "BUFF-YYYP",
      sort_by: targetBalance === "steam"
        ? query.steamExit === "listing" ? 0 : 1
        : query.platformExit === "listing" ? 0 : 1,
      ...(targetBalance === "platform"
        ? { buy: query.steamPurchase === "buy_order" ? 1 : 0 }
        : {}),
      min_price: requireNonNegativeNumber(query.minimumPrice ?? 1, "minimumPrice"),
      max_price: requireNonNegativeNumber(query.maximumPrice ?? 5_000, "maximumPrice"),
      turnover: requireNonNegativeNumber(query.minimumTurnover ?? 10, "minimumTurnover"),
    });
    return verifiedEvidence(`csqaq:hanging-candidates:${targetBalance}`, observedAt, parseHangingEntries(data), [
      "Candidate prices and turnover are provider snapshots and do not guarantee execution after the seven-day Steam trade restriction.",
      "providerExchangeRatio is retained as a provider-defined metric and is independently recalculated before assessment.",
      "Abnormal cross-platform quotes must be rejected by local price-sanity checks before ranking.",
    ]);
  }

  async getMarketHomeData(): Promise<Evidence<CsQaqMarketHomeData>> {
    const observedAt = this.#now();
    const data = await this.#requestData("/api/v1/current_data", "GET", undefined, { type: "init" });
    return verifiedEvidence("csqaq:market-home", observedAt, parseMarketHomeData(data), [
      "Sector indices and Steam card prices use CSQAQ's methodology and update schedule.",
      "The card price is RMB paid per 100 USD Steam wallet face value, not a foreign-exchange rate.",
    ]);
  }

  async getSectorKline(
    sectorId: string,
    interval = "1day",
  ): Promise<Evidence<readonly CsQaqSectorKlinePoint[]>> {
    const id = requireText(sectorId, "sectorId");
    const type = requireText(interval, "interval");
    const observedAt = this.#now();
    const data = await this.#requestData("/api/v1/sub/kline", "GET", undefined, { id, type });
    return verifiedEvidence("csqaq:sector-kline", observedAt, parseSectorKline(data), [
      "Sector K-lines are provider-defined index observations, not transaction records.",
    ]);
  }

  async getCollections(): Promise<Evidence<readonly CsQaqCollection[]>> {
    const observedAt = this.#now();
    const data = await this.#requestData("/api/v1/info/container_data_info", "POST");
    return verifiedEvidence("csqaq:collections", observedAt, parseCollections(data), [
      "The provider catalog can include cases, souvenir packages, capsules, and collections; local trade-up analysis filters unsupported categories.",
    ]);
  }

  async getCollectionItems(collectionId: string): Promise<Evidence<readonly CsQaqCollectionItem[]>> {
    const id = requireText(collectionId, "collectionId");
    const observedAt = this.#now();
    const data = await this.#requestData("/api/v1/info/good/container_detail", "GET", undefined, { id });
    return verifiedEvidence("csqaq:collection-items", observedAt, parseCollectionItems(data), [
      "Reference prices and rarity labels are provider snapshots.",
      "A shared collection and adjacent rarity establish a trade-up relationship, not a guaranteed profitable contract.",
    ]);
  }

  async getCaseCounts(): Promise<Evidence<readonly CsQaqCaseCountEntry[]>> {
    const observedAt = this.#now();
    const data = await this.#requestData("/api/v1/stat/case", "GET");
    return verifiedEvidence("csqaq:case-opening-counts", observedAt, parseCaseCounts(data), [
      "Opening counts and update times use the provider's methodology and may be delayed.",
    ]);
  }

  async getCaseRoi(): Promise<Evidence<readonly CsQaqCaseRoiEntry[]>> {
    const observedAt = this.#now();
    const data = await this.#requestData("/api/v1/info/roi", "POST");
    return verifiedEvidence("csqaq:case-roi", observedAt, parseCaseRoi(data), [
      "Case ROI is provider-calculated expected value, not a guaranteed return for an individual opening.",
    ]);
  }

  async getBatchPriceQuotes(
    marketHashNames: readonly string[],
  ): Promise<Evidence<readonly NormalizedMarketQuote[]>> {
    const names = marketHashNames.map((name) => name.trim()).filter(Boolean);
    if (names.length === 0 || names.length > 50) {
      throw new AppError("USAGE_ERROR", "CSQAQ batch price query requires 1 to 50 marketHashNames.");
    }
    const observedAt = this.#now();
    const data = await this.#requestData(
      "/api/v1/goods/getPriceByMarketHashName",
      "POST",
      { marketHashNameList: names },
    );
    return verifiedEvidence(
      "csqaq:batch-prices",
      observedAt,
      normalizeCsQaqPersonalPriceData(data, observedAt),
      [
        "CSQAQ personal batch prices currently expose BUFF, YYYP, and Steam listing snapshots.",
        "Provider refresh times and platform definitions may differ from SteamDT.",
        "A price difference is not proof of executable arbitrage.",
      ],
    );
  }

  async auditProbe(spec: CsQaqProbeSpec): Promise<CsQaqAuditProbeResult> {
    const requestedAt = this.#now().toISOString();
    const startedAt = Date.now();
    const url = new URL(`${this.baseUrl}${spec.path}`);
    for (const [key, value] of Object.entries(spec.query ?? {})) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: spec.method,
        headers: {
          ApiToken: this.#apiToken,
          Accept: "application/json",
          ...(spec.body ? { "Content-Type": "application/json" } : {}),
          "User-Agent": "cs2-item-agent/0.1 permission-audit",
        },
        signal: AbortSignal.timeout(this.#timeoutMs),
        ...(spec.body ? { body: JSON.stringify(spec.body) } : {}),
      });
    } catch {
      return this.#result(spec, requestedAt, startedAt, "network_error", {
        providerMessage: "Request failed before a response was received.",
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return this.#result(spec, requestedAt, startedAt, "contract_rejected", {
        httpStatus: response.status,
        providerMessage: "Provider returned a non-JSON response.",
      });
    }

    const envelope = isRecord(payload) ? payload : undefined;
    const providerCode = parseCode(envelope?.code);
    const providerMessage = sanitizeMessage(
      typeof envelope?.msg === "string"
        ? envelope.msg
        : typeof envelope?.message === "string"
          ? envelope.message
          : undefined,
      this.#apiToken,
    );
    const status = classifyStatus(response.status, providerCode, providerMessage);

    return this.#result(spec, requestedAt, startedAt, status, {
      httpStatus: response.status,
      ...(providerCode !== undefined ? { providerCode } : {}),
      ...(providerMessage ? { providerMessage } : {}),
      dataShape: summarizeData(envelope?.data),
    });
  }

  async #requestData(
    path: string,
    method: "GET" | "POST",
    body?: Readonly<Record<string, unknown>>,
    query?: Readonly<Record<string, string>>,
  ): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const waitMs = this.#minimumRequestIntervalMs - (Date.now() - this.#lastRequestStartedAt);
    if (waitMs > 0) await this.#delay(waitMs);
    this.#lastRequestStartedAt = Date.now();
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: {
          ApiToken: this.#apiToken,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          "User-Agent": "cs2-item-agent/0.1",
        },
        signal: AbortSignal.timeout(this.#timeoutMs),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new AppError("HTTP_ERROR", "CSQAQ request failed before a response was received.");
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AppError("CONTRACT_ERROR", "CSQAQ returned invalid JSON.", {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "unknown",
      });
    }
    const envelope = isRecord(payload) ? payload : undefined;
    const providerCode = parseCode(envelope?.code);
    const providerMessage = sanitizeMessage(
      typeof envelope?.msg === "string" ? envelope.msg : undefined,
      this.#apiToken,
    );
    if (!response.ok || Number(providerCode) !== 200) {
      throw new AppError("PROVIDER_ERROR", providerMessage ?? "CSQAQ rejected the request.", {
        status: response.status,
        ...(providerCode !== undefined ? { providerCode } : {}),
      });
    }
    if (envelope?.data === undefined) {
      throw new AppError("CONTRACT_ERROR", "CSQAQ success response is missing data.");
    }
    return envelope.data;
  }

  #result(
    spec: CsQaqProbeSpec,
    requestedAt: string,
    startedAt: number,
    status: CsQaqAuditStatus,
    extra: Partial<CsQaqAuditProbeResult>,
  ): CsQaqAuditProbeResult {
    return {
      id: spec.id,
      label: spec.label,
      documentedTier: spec.documentedTier,
      status,
      requestedAt,
      durationMs: Math.max(0, Date.now() - startedAt),
      dataShape: extra.dataShape ?? { kind: "missing", fields: [] },
      ...(extra.httpStatus !== undefined ? { httpStatus: extra.httpStatus } : {}),
      ...(extra.providerCode !== undefined ? { providerCode: extra.providerCode } : {}),
      ...(extra.providerMessage ? { providerMessage: extra.providerMessage } : {}),
      ...(spec.note ? { note: spec.note } : {}),
    };
  }
}

function classifyStatus(
  httpStatus: number,
  providerCode: string | number | undefined,
  providerMessage: string | undefined,
): CsQaqAuditStatus {
  const code = typeof providerCode === "number" ? providerCode : Number(providerCode);
  const message = providerMessage?.toLowerCase() ?? "";

  if (httpStatus === 429 || code === 429 || message.includes("频繁") || message.includes("rate")) {
    return "rate_limited";
  }
  if (message.includes("白名单") || message.includes("whitelist") || message.includes("绑定ip")) {
    return "configuration_required";
  }
  if (httpStatus === 401 || code === 401 || message.includes("token") || message.includes("认证")) {
    return "authentication_failed";
  }
  if (
    httpStatus === 403 ||
    code === 403 ||
    message.includes("权限") ||
    message.includes("企业") ||
    message.includes("forbidden") ||
    message.includes("permission")
  ) {
    return "permission_denied";
  }
  if (httpStatus === 422 || code === 422) return "contract_rejected";
  if (httpStatus >= 500 || code >= 500) return "unavailable";
  if (responseSucceeded(httpStatus, providerCode)) return "available";
  return "provider_rejected";
}

function responseSucceeded(httpStatus: number, providerCode: string | number | undefined): boolean {
  if (httpStatus < 200 || httpStatus >= 300) return false;
  if (providerCode === undefined) return true;
  return Number(providerCode) === 200;
}

function summarizeData(value: unknown): CsQaqDataShape {
  if (value === undefined) return { kind: "missing", fields: [] };
  if (value === null) return { kind: "null", fields: [] };
  if (Array.isArray(value)) {
    const first = value.find(isRecord);
    return {
      kind: "array",
      rowCount: value.length,
      fields: first ? Object.keys(first).sort().slice(0, 40) : [],
    };
  }
  if (isRecord(value)) {
    const fields = Object.keys(value).sort();
    for (const [containerName, container] of Object.entries(value)) {
      if (Array.isArray(container)) {
        const first = container.find(isRecord);
        if (first) fields.push(...Object.keys(first).map((key) => `${containerName}[].${key}`));
      } else if (isRecord(container)) {
        const firstNested = Object.values(container).find(isRecord);
        if (firstNested) {
          fields.push(...Object.keys(firstNested).map((key) => `${containerName}[].${key}`));
        }
      }
    }
    return { kind: "object", fields: [...new Set(fields)].sort().slice(0, 40) };
  }
  return { kind: "primitive", fields: [] };
}

function parseCode(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function sanitizeMessage(value: string | undefined, token: string): string | undefined {
  if (!value) return undefined;
  return value.replaceAll(token, "[REDACTED]").slice(0, 300);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseItemIdentities(value: unknown): readonly CsQaqItemIdentity[] {
  const container = isRecord(value) && isRecord(value.data) ? value.data : value;
  if (!isRecord(container)) throw new AppError("CONTRACT_ERROR", "CSQAQ item identity data must be an object map.");
  return Object.values(container).map((entry, index) => {
    const record = requireRecord(entry, `item identity ${index}`);
    return {
      goodId: requireScalarText(record.id, "item identity id"),
      name: requireTextField(record.name, "item identity name"),
      marketHashName: requireTextField(record.market_hash_name, "item identity market_hash_name"),
    };
  });
}

function parseItemIdentityPage(value: unknown): CsQaqItemIdentityPage {
  const root = requireRecord(value, "item identity page");
  return {
    pageIndex: optionalPositiveInteger(root.page_index) ?? 1,
    pageSize: optionalPositiveInteger(root.page_size) ?? 50,
    total: optionalNonNegativeInteger(root.total) ?? parseItemIdentities(value).length,
    items: parseItemIdentities(value),
  };
}

function parseItemDetail(value: unknown): CsQaqItemDetail {
  const root = requireRecord(value, "item detail response");
  const record = requireRecord(root.goods_info, "item detail goods_info");
  return {
    goodId: requireScalarText(record.id, "item detail id"),
    name: requireTextField(record.name, "item detail name"),
    marketHashName: requireTextField(record.market_hash_name, "item detail market_hash_name"),
    ...optionalText(record.img, "imageUrl"),
    ...optionalText(record.type_localized_name, "typeName"),
    ...optionalText(record.rarity_localized_name, "rarityName"),
    ...optionalText(record.exterior_localized_name, "exteriorName"),
    ...optionalNumber(record.def_index, "defIndex"),
    ...optionalNumber(record.paint_index, "paintIndex"),
    ...optionalNumber(record.min_float, "minimumFloat"),
    ...optionalNumber(record.max_float, "maximumFloat"),
    ...optionalNumber(record.buff_sell_price, "buffSellPrice"),
    ...optionalNumber(record.yyyp_sell_price, "yyypSellPrice"),
    ...optionalNumber(record.steam_sell_price, "steamSellPrice"),
    ...optionalIsoDateText(record.updated_at, "updatedAt"),
  };
}

function parseHolderRanking(value: unknown): readonly CsQaqHolderRankEntry[] {
  return requireArray(value, "holder ranking").map((entry, index) => {
    const record = requireRecord(entry, `holder ranking ${index}`);
    return {
      monitorId: requireScalarText(record.id, "holder monitor id"),
      steamName: requireTextField(record.steam_name, "holder steam_name"),
      steamId: requireScalarText(record.steam_id, "holder steam_id"),
      quantity: requireFiniteNumber(record.num, "holder num"),
      ...optionalText(record.avatar, "avatarUrl"),
    };
  });
}

function parseSupplyTrend(value: unknown): readonly CsQaqSupplyPoint[] {
  return requireArray(value, "supply trend")
    .map((entry, index) => {
      const record = requireRecord(entry, `supply point ${index}`);
      return {
        quantity: requireFiniteNumber(record.statistic, "supply statistic"),
        recordedAt: requireIsoDateText(record.created_at, "supply created_at"),
      };
    })
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

function parseHangingEntries(value: unknown): readonly CsQaqHangingEntry[] {
  return requireArray(value, "hanging candidates").map((entry, index) => {
    const record = requireRecord(entry, `hanging candidate ${index}`);
    return {
      goodId: requireScalarText(record.id, "hanging id"),
      marketHashName: requireTextField(record.market_hash_name, "hanging market_hash_name"),
      name: requireTextField(record.name, "hanging name"),
      ...optionalText(record.img, "imageUrl"),
      ...optionalScalarText(record.buff_id, "buffItemId"),
      ...optionalNumber(record.buff_sell_price, "buffSellPrice"),
      ...optionalNumber(record.buff_sell_num, "buffSellCount"),
      ...optionalNumber(record.buff_buy_price, "buffBidPrice"),
      ...optionalNumber(record.buff_buy_num, "buffBidCount"),
      ...optionalScalarText(record.yyyp_id, "yyypItemId"),
      ...optionalNumber(record.yyyp_sell_price, "yyypSellPrice"),
      ...optionalNumber(record.yyyp_sell_num, "yyypSellCount"),
      ...optionalNumber(record.yyyp_buy_price, "yyypBidPrice"),
      ...optionalNumber(record.yyyp_buy_num, "yyypBidCount"),
      ...optionalNumber(record.steam_sell_price, "steamSellPrice"),
      ...optionalNumber(record.steam_sell_num, "steamSellCount"),
      ...optionalNumber(record.steam_buy_price, "steamBidPrice"),
      ...optionalNumber(record.steam_buy_num, "steamBidCount"),
      ...optionalNumber(record.max_price, "providerExchangeRatio"),
      ...optionalNumber(record.turnover_number, "turnoverNumber"),
    };
  });
}

function parseMarketHomeData(value: unknown): CsQaqMarketHomeData {
  const record = requireRecord(value, "market home data");
  const sectors = requireArray(record.sub_index_data, "sector index").map((entry, index) => {
    const row = requireRecord(entry, `sector index ${index}`);
    return {
      id: requireScalarText(row.id, "sector id"),
      name: requireTextField(row.name, "sector name"),
      nameKey: requireTextField(row.name_key, "sector name_key"),
      ...optionalText(row.img, "imageUrl"),
      marketIndex: requireFiniteNumber(row.market_index, "sector market_index"),
      changeAmount: requireFiniteNumber(row.chg_num, "sector chg_num"),
      changeRatePct: requireFiniteNumber(row.chg_rate, "sector chg_rate"),
      open: requireFiniteNumber(row.open, "sector open"),
      close: requireFiniteNumber(row.close, "sector close"),
      high: requireFiniteNumber(row.high, "sector high"),
      low: requireFiniteNumber(row.low, "sector low"),
      updatedAt: requireIsoDateText(row.updated_at, "sector updated_at"),
    };
  });
  return { sectors, cardPrices: parseCardPrices(record.card_price) };
}

function parseCardPrices(value: unknown): readonly import("./types.js").CsQaqCardPricePoint[] {
  if (value === undefined || value === null) return [];
  const rows = Array.isArray(value) ? value : [value];
  return rows.flatMap((entry, index) => {
    if (typeof entry === "number" || typeof entry === "string") {
      const price = Number(entry);
      return Number.isFinite(price) && price > 0
        ? [{ priceCnyPer100Usd: price, recordedAt: thisDayIso() }]
        : [];
    }
    if (!isRecord(entry)) return [];
    const price = firstFinite(entry.price, entry.card_price, entry.value, entry.close);
    const date = firstText(entry.created_at, entry.updated_at, entry.date, entry.time);
    if (price === undefined || price <= 0) return [];
    return [{
      priceCnyPer100Usd: price,
      recordedAt: date ? parseFlexibleDate(date, `card price ${index}`) : thisDayIso(),
    }];
  }).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

function parseSectorKline(value: unknown): readonly CsQaqSectorKlinePoint[] {
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      const row = requireRecord(entry, `sector kline ${index}`);
      return {
        timestamp: requireTimestamp(row.t ?? row.timestamp, "sector kline timestamp"),
        open: requireFiniteNumber(row.o ?? row.open, "sector kline open"),
        close: requireFiniteNumber(row.c ?? row.close, "sector kline close"),
        high: requireFiniteNumber(row.h ?? row.high, "sector kline high"),
        low: requireFiniteNumber(row.l ?? row.low, "sector kline low"),
        ...optionalNumber(row.v ?? row.volume, "volume"),
      };
    }).sort((a, b) => a.timestamp - b.timestamp);
  }
  const record = requireRecord(value, "sector kline");
  const timestamps = requireArray(record.timestamp, "sector kline timestamps");
  const opens = requireArray(record.open, "sector kline opens");
  const closes = requireArray(record.close, "sector kline closes");
  const highs = requireArray(record.high, "sector kline highs");
  const lows = requireArray(record.low, "sector kline lows");
  const volumes = Array.isArray(record.volume) ? record.volume : [];
  return timestamps.map((timestamp, index) => ({
    timestamp: requireTimestamp(timestamp, "sector kline timestamp"),
    open: requireFiniteNumber(opens[index], "sector kline open"),
    close: requireFiniteNumber(closes[index], "sector kline close"),
    high: requireFiniteNumber(highs[index], "sector kline high"),
    low: requireFiniteNumber(lows[index], "sector kline low"),
    ...(volumes[index] !== undefined ? optionalNumber(volumes[index], "volume") : {}),
  })).sort((a, b) => a.timestamp - b.timestamp);
}

function parseCollections(value: unknown): readonly CsQaqCollection[] {
  return requireArray(value, "collections").map((entry, index) => {
    const row = requireRecord(entry, `collection ${index}`);
    return {
      id: requireScalarText(row.id, "collection id"),
      name: requireTextField(row.name, "collection name"),
      ...optionalText(row.comment, "comment"),
      ...optionalText(row.img, "imageUrl"),
      ...optionalIsoDateText(row.created_at, "createdAt"),
    };
  });
}

function parseCollectionItems(value: unknown): readonly CsQaqCollectionItem[] {
  return requireArray(value, "collection items").map((entry, index) => {
    const row = requireRecord(entry, `collection item ${index}`);
    const rarity = firstText(row.rln, row.rarity_name, row.rarity, row.qln);
    if (!rarity) throw new AppError("CONTRACT_ERROR", "CSQAQ collection item rarity is missing.");
    return {
      goodId: requireScalarText(row.id ?? row.good_id, "collection item id"),
      name: requireTextField(row.short_name ?? row.name, "collection item name"),
      rarityName: rarity,
      ...optionalText(row.qln, "qualityName"),
      ...optionalNumber(row.price, "referencePrice"),
      ...optionalText(row.img, "imageUrl"),
    };
  });
}

function firstFinite(...values: readonly unknown[]): number | undefined {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function firstText(...values: readonly unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function requireTimestamp(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new AppError("CONTRACT_ERROR", `CSQAQ ${label} must be a timestamp.`);
  return parsed < 10_000_000_000 ? parsed * 1_000 : parsed;
}

function parseFlexibleDate(value: string, label: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new AppError("CONTRACT_ERROR", `CSQAQ ${label} must be a date.`);
  return parsed.toISOString();
}

function thisDayIso(): string {
  return new Date().toISOString();
}

function parseCaseCounts(value: unknown): readonly CsQaqCaseCountEntry[] {
  return requireArray(value, "case counts").map((entry, index) => {
    const record = requireRecord(entry, `case count ${index}`);
    return {
      caseId: requireScalarText(record.case_id, "case_id"),
      goodId: requireScalarText(record.good_id, "case good_id"),
      name: requireTextField(record.cn_name, "case cn_name"),
      daily: requireFiniteNumber(record.daily, "case daily"),
      weekly: requireFiniteNumber(record.weekly, "case weekly"),
      monthly: requireFiniteNumber(record.monthly, "case monthly"),
      total: requireFiniteNumber(record.total, "case total"),
      type: requireFiniteNumber(record.type, "case type"),
      observedAt: requireIsoDateText(record.created_at, "case created_at"),
      ...optionalIsoDateText(record.ground_at, "releasedAt"),
      ...optionalText(record.img, "imageUrl"),
    };
  });
}

function parseCaseRoi(value: unknown): readonly CsQaqCaseRoiEntry[] {
  return requireArray(value, "case ROI").flatMap((entry, index) => {
    const record = requireRecord(entry, `case ROI ${index}`);
    if (record.good_id === undefined || record.good_id === null || record.good_id === "") return [];
    return [{
      id: requireScalarText(record.id, "ROI id"),
      goodId: requireScalarText(record.good_id, "ROI good_id"),
      name: requireTextField(record.name, "ROI name"),
      sampleCount: requireFiniteNumber(record.num, "ROI num"),
      price: requireFiniteNumber(record.price, "ROI price"),
      roiPercent: requireFiniteNumber(record.roi, "ROI roi"),
      expectedIncome: requireFiniteNumber(record.income, "ROI income"),
      updatedAt: requireIsoDateText(record.updated_at, "ROI updated_at"),
      ...optionalText(record.comment, "category"),
      ...optionalText(record.img, "imageUrl"),
    }];
  });
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new AppError("CONTRACT_ERROR", `CSQAQ ${label} data must be an array.`);
  return value;
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new AppError("CONTRACT_ERROR", `CSQAQ ${label} must be an object.`);
  return value;
}

function requireText(value: string, label: string): string {
  const cleaned = value.trim();
  if (!cleaned) throw new AppError("USAGE_ERROR", `${label} cannot be empty.`);
  return cleaned;
}

function requireTextField(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new AppError("CONTRACT_ERROR", `CSQAQ ${label} must be text.`);
  return value.trim();
}

function requireScalarText(value: unknown, label: string): string {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") {
    throw new AppError("CONTRACT_ERROR", `CSQAQ ${label} must be a string or number.`);
  }
  return String(value);
}

function requireFiniteNumber(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new AppError("CONTRACT_ERROR", `CSQAQ ${label} must be numeric.`);
  return parsed;
}

function requireIsoDateText(value: unknown, label: string): string {
  const text = requireTextField(value, label);
  const date = new Date(text);
  if (Number.isNaN(date.valueOf())) throw new AppError("CONTRACT_ERROR", `CSQAQ ${label} must be a date.`);
  return date.toISOString();
}

function optionalText<K extends string>(value: unknown, key: K): Partial<Record<K, string>> {
  return typeof value === "string" && value.trim() ? ({ [key]: value.trim() } as Record<K, string>) : {};
}

function optionalScalarText<K extends string>(value: unknown, key: K): Partial<Record<K, string>> {
  return typeof value === "string" || typeof value === "number"
    ? ({ [key]: String(value) } as Record<K, string>)
    : {};
}

function optionalNumber<K extends string>(value: unknown, key: K): Partial<Record<K, number>> {
  if (value === undefined || value === null || value === "") return {};
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return {};
  return { [key]: parsed } as Record<K, number>;
}

function optionalIsoDateText<K extends string>(value: unknown, key: K): Partial<Record<K, string>> {
  if (typeof value !== "string") return {};
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? {} : ({ [key]: date.toISOString() } as Record<K, string>);
}

function optionalPositiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new AppError("USAGE_ERROR", `${label} must be a positive integer.`);
  return value;
}

function requireNonNegativeNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new AppError("USAGE_ERROR", `${label} must be a non-negative number.`);
  return value;
}
