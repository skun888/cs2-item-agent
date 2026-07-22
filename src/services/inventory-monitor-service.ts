import { SteamInventoryClient, validateSteamId64 } from "../adapters/steam-inventory/client.js";
import type { WechatNotifier } from "../adapters/notifications/wechat.js";
import { AppError, toPublicError } from "../core/errors.js";
import type {
  InventoryHolderRankResult,
  InventoryCheckReport,
  LatestInventoryQueryResult,
  InventoryWatch,
} from "../domain/inventory-monitor.js";
import { summarizeInventoryHoldings, toInventoryAssetView } from "../domain/inventory-monitor.js";
import type { InventoryValuationSnapshot } from "../domain/inventory-valuation.js";
import { AppDatabase } from "../storage/database.js";
import type { InventoryValuationService } from "./inventory-valuation-service.js";

export interface InventoryMonitorServiceOptions {
  readonly defaultIntervalMinutes?: number;
  readonly notifier?: WechatNotifier;
  readonly valuationService?: InventoryValuationService;
  readonly now?: () => Date;
}

export class InventoryMonitorService {
  readonly #client: SteamInventoryClient;
  readonly #database: AppDatabase;
  readonly #defaultIntervalMinutes: number;
  readonly #notifier: WechatNotifier | undefined;
  readonly #valuationService: InventoryValuationService | undefined;
  readonly #now: () => Date;

  constructor(
    client: SteamInventoryClient,
    database: AppDatabase,
    options: InventoryMonitorServiceOptions = {},
  ) {
    this.#client = client;
    this.#database = database;
    this.#defaultIntervalMinutes = options.defaultIntervalMinutes ?? 30;
    this.#notifier = options.notifier;
    this.#valuationService = options.valuationService;
    this.#now = options.now ?? (() => new Date());
  }

  async check(
    steamId: string,
    options: { readonly notify?: boolean; readonly label?: string } = {},
  ): Promise<InventoryCheckReport> {
    const result = await this.#client.getCs2Inventory(steamId);
    const persisted = this.#database.saveInventoryFetchResult(result);
    this.#database.markInventoryWatchChecked(steamId, result.observedAt);

    const added = persisted.events.filter((event) => event.eventType === "observed_added").length;
    const removed = persisted.events.filter((event) => event.eventType === "observed_removed").length;
    const quantityChanged = persisted.events.filter((event) => event.eventType === "quantity_changed").length;
    const limitations = limitationsFor(
      result.status,
      persisted.baselineCreated,
      result.assets.length,
      result.totalInventoryCount,
    );
    const valuation = await this.#valueIfPossible(
      result.status,
      result.complete,
      persisted.snapshotId,
      steamId,
      result.observedAt,
      result.assets,
      persisted.events,
    );
    const notification = options.notify
      ? await this.#notifyIfNeeded(
          steamId,
          options.label,
          result.observedAt,
          persisted.events.length,
          added,
          removed,
          quantityChanged,
          persisted.categoryChanges,
          valuation.status === "available" ? valuation.data : undefined,
        )
      : undefined;

    return {
      steamId,
      source: result.source,
      observedAt: result.observedAt,
      status: result.status,
      ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
      ...(result.message ? { message: result.message } : {}),
      complete: result.complete,
      pageCount: result.pageCount,
      ...(result.status === "public" ? { assetCount: result.assets.length } : {}),
      ...(result.totalInventoryCount !== undefined
        ? { totalInventoryCount: result.totalInventoryCount }
        : {}),
      holdings: result.status === "public" ? summarizeInventoryHoldings(result.assets).slice(0, 20) : [],
      baselineCreated: persisted.baselineCreated,
      ...(persisted.previousObservedAt ? { previousObservedAt: persisted.previousObservedAt } : {}),
      changes: {
        added,
        removed,
        quantityChanged,
        events: persisted.events.slice(0, 100),
        categoryChanges: persisted.categoryChanges.slice(0, 100),
      },
      confidence: result.status === "public" ? "verified_source" : "unknown",
      valuation,
      limitations: [
        ...limitations,
        ...(persisted.events.length > 100
          ? [`共 ${persisted.events.length} 条变动，当前响应只展示前 100 条；完整事件保存在本地数据库。`]
          : []),
      ],
      ...(notification ? { notification } : {}),
    };
  }

  addWatch(input: {
    readonly steamId: string;
    readonly label?: string;
    readonly intervalMinutes?: number;
  }): InventoryWatch {
    validateSteamId64(input.steamId);
    const intervalMinutes = input.intervalMinutes ?? this.#defaultIntervalMinutes;
    if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0 || intervalMinutes > 10_080) {
      throw new AppError("USAGE_ERROR", "intervalMinutes must be an integer from 1 to 10080.");
    }
    return this.#database.upsertInventoryWatch(input.steamId, {
      ...(input.label ? { label: input.label } : {}),
      intervalMinutes,
      now: this.#now().toISOString(),
    });
  }

  listWatches(): readonly InventoryWatch[] {
    return this.#database.listInventoryWatches();
  }

  queryLatestInventory(input: {
    readonly steamId: string;
    readonly marketHashName?: string;
    readonly limit?: number;
  }): LatestInventoryQueryResult {
    validateSteamId64(input.steamId);
    const limit = normalizeLimit(input.limit, 100, 500);
    const snapshot = this.#database.getLatestInventorySnapshot(input.steamId);
    if (!snapshot) {
      return {
        steamId: input.steamId,
        status: "no_successful_snapshot",
        ...(input.marketHashName ? { filter: input.marketHashName } : {}),
        totalMatchingAssets: 0,
        returnedAssets: 0,
        assets: [],
        holdings: [],
        limitations: ["本地数据库中还没有该 SteamID 的成功公开库存响应快照。"],
      };
    }
    const normalizedFilter = input.marketHashName?.trim().toLocaleLowerCase();
    const matching = normalizedFilter
      ? snapshot.assets.filter((asset) => asset.marketHashName?.toLocaleLowerCase() === normalizedFilter)
      : snapshot.assets;
    const returned = matching.slice(0, limit);
    return {
      steamId: input.steamId,
      observedAt: snapshot.observedAt,
      status: "available",
      ...(input.marketHashName ? { filter: input.marketHashName } : {}),
      totalMatchingAssets: matching.length,
      returnedAssets: returned.length,
      assets: returned.map(toInventoryAssetView),
      holdings: summarizeInventoryHoldings(matching).slice(0, 100),
      limitations: [
        "结果来自该账号最近一次成功公开响应快照，不代表此刻仍未变化。",
        "精确磨损、模板和观察指纹仅在 Steam asset_properties 提供相应字段时存在。",
        ...(matching.length > limit
          ? [`匹配 ${matching.length} 个资产，本次只返回前 ${limit} 个。`]
          : []),
      ],
    };
  }

  rankHolders(input: {
    readonly marketHashName: string;
    readonly limit?: number;
  }): InventoryHolderRankResult {
    const marketHashName = input.marketHashName.trim();
    if (!marketHashName) throw new AppError("USAGE_ERROR", "marketHashName is required.");
    const ranked = this.#database.rankInventoryHolders(
      marketHashName,
      normalizeLimit(input.limit, 20, 100),
    );
    return {
      marketHashName,
      coverage: {
        latestSuccessfulSnapshots: ranked.latestSuccessfulSnapshots,
        matchingAccounts: ranked.holders.length,
      },
      holders: ranked.holders,
      confidence: ranked.latestSuccessfulSnapshots > 0 ? "verified_source" : "unknown",
      limitations: [
        "该排行只覆盖用户本地数据库中有成功完整快照的 SteamID，不是全网持有人排行。",
        "数量按每个账号最近一次成功快照统计；不同账号快照时间可能不同。",
        "公开库存只能证明观察时持有，不能证明买入来源或现实关系。",
      ],
    };
  }

  queryLatestValuation(steamId: string): InventoryValuationSnapshot | undefined {
    validateSteamId64(steamId);
    return this.#database.getLatestInventoryValuation(steamId);
  }

  disableWatch(steamId: string): boolean {
    validateSteamId64(steamId);
    return this.#database.setInventoryWatchEnabled(steamId, false, this.#now().toISOString());
  }

  async runWatchesOnce(options: { readonly dueOnly?: boolean } = {}): Promise<readonly InventoryCheckReport[]> {
    const at = this.#now().toISOString();
    const watches = options.dueOnly
      ? this.#database.listDueInventoryWatches(at)
      : this.#database.listInventoryWatches(true);
    const reports: InventoryCheckReport[] = [];
    for (const watch of watches) {
      reports.push(await this.check(watch.steamId, { notify: true, ...(watch.label ? { label: watch.label } : {}) }));
    }
    return reports;
  }

  async #notifyIfNeeded(
    steamId: string,
    label: string | undefined,
    attemptedAt: string,
    eventCount: number,
    added: number,
    removed: number,
    quantityChanged: number,
    categoryChanges: readonly { readonly marketHashName: string; readonly delta: number }[],
    valuation: InventoryValuationSnapshot | undefined,
  ): Promise<{ readonly status: "sent" | "skipped" | "failed"; readonly message?: string }> {
    if (eventCount === 0) return { status: "skipped", message: "No inventory changes to notify." };
    if (!this.#notifier) return { status: "skipped", message: "WECHAT_WEBHOOK_URL is not configured." };
    const identity = label?.trim() || maskSteamId(steamId);
    const categoryLines = categoryChanges
      .slice(0, 8)
      .map((entry) => `${entry.delta > 0 ? "+" : ""}${entry.delta} ${entry.marketHashName}`);
    const valuationLines = valuation
      ? [
          `BUFF 基础估值：¥${valuation.knownSubtotal.toFixed(2)}（价格覆盖率 ${(valuation.priceCoverage * 100).toFixed(1)}%）`,
          ...(valuation.compositionDelta !== undefined
            ? [`库存构成估值变化：${formatSignedMoney(valuation.compositionDelta)}${valuation.compositionDeltaRate !== undefined ? `（${formatSignedPercent(valuation.compositionDeltaRate)}）` : ""}`]
            : []),
          ...(valuation.marketPriceDelta !== undefined
            ? [`市场价格影响：${formatSignedMoney(valuation.marketPriceDelta)}`]
            : []),
          ...(valuation.highValueEventCount > 0
            ? [`单件基础价 ≥ ¥1,000 的变动事件：${valuation.highValueEventCount} 条（仅记录，不单独触发高价值告警）`]
            : []),
          ...(valuation.priceCoverage < 0.9
            ? ["价格覆盖率低于 90%，不判断总估值高价值异动。"]
            : []),
        ]
      : [];
    const text = [
      `${valuation?.highValueAlertEligible ? "【高价值库存异动】" : "CS2 公开库存变动"}：${identity}`,
      `观察时间：${attemptedAt}`,
      `新增 ${added}，移除 ${removed}，数量变化 ${quantityChanged}`,
      ...categoryLines,
      ...valuationLines,
      "说明：这是公开库存快照差异，不等同于买入、卖出或已确认交易。",
    ].join("\n");
    try {
      const sent = await this.#notifier.sendTextWithRetry(text);
      this.#database.saveNotificationDelivery({
        steamId,
        channel: "enterprise_wechat",
        eventCount,
        status: "sent",
        attemptedAt,
        message: sent.message,
        attemptCount: sent.attemptCount,
      });
      return sent;
    } catch (error) {
      const publicError = toPublicError(error);
      const message = extractPublicErrorMessage(publicError);
      const attemptCount = extractAttemptCount(publicError);
      this.#database.saveNotificationDelivery({
        steamId,
        channel: "enterprise_wechat",
        eventCount,
        status: "failed",
        attemptedAt,
        message,
        attemptCount,
      });
      return { status: "failed", message };
    }
  }

  async #valueIfPossible(
    status: "public" | "private_or_unavailable" | "rate_limited" | "temporary_failure",
    complete: boolean,
    snapshotId: number | undefined,
    steamId: string,
    inventoryObservedAt: string,
    assets: Parameters<InventoryValuationService["valueSnapshot"]>[0]["assets"],
    inventoryEvents: Parameters<InventoryValuationService["valueSnapshot"]>[0]["inventoryEvents"],
  ): Promise<InventoryCheckReport["valuation"]> {
    if (status !== "public" || !complete || snapshotId === undefined) {
      return { status: "skipped", message: "Only complete successful public snapshots are valued." };
    }
    if (!this.#valuationService) {
      return { status: "not_configured", message: "Configure SteamDT or CSQAQ to enable BUFF inventory valuation." };
    }
    try {
      const data = await this.#valuationService.valueSnapshot({
        snapshotId,
        steamId,
        inventoryObservedAt,
        assets,
        inventoryEvents,
      });
      return { status: "available", data };
    } catch (error) {
      return {
        status: "failed",
        message: error instanceof Error ? error.message : "Inventory valuation failed.",
      };
    }
  }
}

function limitationsFor(
  status: "public" | "private_or_unavailable" | "rate_limited" | "temporary_failure",
  baselineCreated: boolean,
  returnedAssetRows: number,
  providerTotalInventoryCount: number | undefined,
): readonly string[] {
  if (status !== "public") {
    return [
      "本次没有取得完整公开库存，因此没有生成新增或移除事件。",
      "私密、好友可见、限流和临时失败均属于未知状态，不能解释为空库存。",
      ...(status === "temporary_failure"
        ? ["如果当前网络无法直连 Steam Community，请在本地 .env 配置 STEAM_PROXY_URL 后重试。"]
        : []),
    ];
  }
  return [
    ...(baselineCreated ? ["这是首份成功快照，只建立基线，不把现有库存标记为新增。"] : []),
    ...(providerTotalInventoryCount !== undefined && providerTotalInventoryCount !== returnedAssetRows
      ? [
          `Steam 报告库存总数 ${providerTotalInventoryCount}，但公开响应返回 ${returnedAssetRows} 个资产行；当前快照和差异只覆盖实际返回的公开资产。`,
        ]
      : []),
    "新增或消失只表示两次公开库存观察结果不同，不能单独证明买入、卖出或交易对手。",
    "assetid 只用于同一账号相邻快照比较，不能默认是跨账号永久身份标识。",
    "Steam asset_properties 可直接提供部分资产的精确磨损、模板和涂装目录；缺失字段仍保持未知。",
  ];
}

function maskSteamId(steamId: string): string {
  return `${steamId.slice(0, 4)}****${steamId.slice(-4)}`;
}

function extractPublicErrorMessage(value: Readonly<Record<string, unknown>>): string {
  const error = typeof value.error === "object" && value.error !== null
    ? (value.error as Readonly<Record<string, unknown>>)
    : undefined;
  return typeof error?.message === "string" ? error.message : "Notification failed.";
}

function extractAttemptCount(value: Readonly<Record<string, unknown>>): number {
  const error = typeof value.error === "object" && value.error !== null
    ? (value.error as Readonly<Record<string, unknown>>)
    : undefined;
  const details = typeof error?.details === "object" && error.details !== null
    ? (error.details as Readonly<Record<string, unknown>>)
    : undefined;
  return typeof details?.attemptCount === "number" ? details.attemptCount : 1;
}

function normalizeLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new AppError("USAGE_ERROR", `limit must be an integer from 1 to ${maximum}.`);
  }
  return value;
}

function formatSignedMoney(value: number): string {
  return `${value >= 0 ? "+" : "-"}¥${Math.abs(value).toFixed(2)}`;
}

function formatSignedPercent(value: number): string {
  return `${value >= 0 ? "+" : "-"}${(Math.abs(value) * 100).toFixed(1)}%`;
}
