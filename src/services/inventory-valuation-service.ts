import type { CsQaqClient } from "../adapters/csqaq/client.js";
import type { SteamDtClient } from "../adapters/steamdt/client.js";
import { createBuiltInMarketAdapterRegistry } from "../adapters/market/factory.js";
import type { MarketDataAdapter } from "../adapters/market/contract.js";
import { MarketAdapterRegistry } from "../adapters/market/registry.js";
import type { SteamInventoryAsset } from "../adapters/steam-inventory/types.js";
import type { InventoryChangeEvent } from "../domain/inventory-monitor.js";
import {
  aggregateValuationEligibleAssets,
  buildHighValueInventoryEvents,
  calculateInventoryValuation,
  type InventoryBasePrice,
  type InventoryValuationProvider,
  type InventoryValuationSnapshot,
  type InventoryValuationThresholds,
} from "../domain/inventory-valuation.js";
import type { Evidence } from "../domain/evidence.js";
import { AppDatabase } from "../storage/database.js";

interface InventoryBuffPriceSource {
  readonly provider: InventoryValuationProvider;
  readonly batchLimit: number;
  readonly minimumBatchIntervalMs: number;
  fetch(names: readonly string[]): Promise<readonly InventoryBasePrice[]>;
}

export interface InventoryValuationServiceOptions {
  readonly registry?: MarketAdapterRegistry;
  readonly preferredAdapterId?: string;
  readonly steamDt?: SteamDtClient;
  readonly csQaq?: CsQaqClient;
  readonly cacheTtlMs?: number;
  readonly thresholds?: InventoryValuationThresholds;
  readonly now?: () => Date;
}

export class InventoryValuationService {
  readonly #database: AppDatabase;
  readonly #source: InventoryBuffPriceSource;
  readonly #cacheTtlMs: number;
  readonly #thresholds: InventoryValuationThresholds | undefined;
  readonly #now: () => Date;

  constructor(database: AppDatabase, options: InventoryValuationServiceOptions) {
    this.#database = database;
    const registry = options.registry ?? createBuiltInMarketAdapterRegistry({
      ...(options.steamDt ? { steamDt: options.steamDt } : {}),
      ...(options.csQaq ? { csQaq: options.csQaq } : {}),
    });
    const adapter = registry.getPreferredBatchAdapter("BUFF", options.preferredAdapterId);
    this.#source = adapter ? adapterSource(adapter) : missingSource();
    this.#cacheTtlMs = options.cacheTtlMs ?? 30 * 60_000;
    this.#thresholds = options.thresholds;
    this.#now = options.now ?? (() => new Date());
  }

  get provider(): InventoryValuationProvider | undefined {
    return this.#source.provider;
  }

  async valueSnapshot(input: {
    readonly snapshotId: number;
    readonly steamId: string;
    readonly inventoryObservedAt: string;
    readonly assets: readonly SteamInventoryAsset[];
    readonly inventoryEvents: readonly InventoryChangeEvent[];
  }): Promise<InventoryValuationSnapshot> {
    const eligibleNames = aggregateValuationEligibleAssets(input.assets).map((item) => item.marketHashName);
    const changedNames = input.inventoryEvents.flatMap((event) => event.marketHashName ? [event.marketHashName] : []);
    const requestedNames = [...new Set([...eligibleNames, ...changedNames])];
    const resolved = await this.#resolvePrices(requestedNames);
    const previous = this.#database.getLatestInventoryValuation(input.steamId, input.snapshotId);
    const highValueEvents = buildHighValueInventoryEvents({
      inventoryEvents: input.inventoryEvents,
      prices: resolved.prices,
      ...(this.#thresholds ? { threshold: this.#thresholds.singleItemValue } : {}),
    });
    const valuation = calculateInventoryValuation({
      snapshotId: input.snapshotId,
      steamId: input.steamId,
      provider: this.#source.provider,
      inventoryObservedAt: input.inventoryObservedAt,
      valuedAt: this.#now().toISOString(),
      assets: input.assets,
      prices: resolved.prices,
      ...(previous ? { previous } : {}),
      highValueEventCount: highValueEvents.length,
      ...(this.#thresholds ? { thresholds: this.#thresholds } : {}),
      limitations: resolved.limitations,
    });
    return this.#database.saveInventoryValuation(valuation, highValueEvents);
  }

  getLatest(steamId: string): InventoryValuationSnapshot | undefined {
    return this.#database.getLatestInventoryValuation(steamId);
  }

  async #resolvePrices(
    marketHashNames: readonly string[],
  ): Promise<{ readonly prices: readonly InventoryBasePrice[]; readonly limitations: readonly string[] }> {
    const now = this.#now();
    const cached: InventoryBasePrice[] = [];
    const missing: string[] = [];
    for (const name of marketHashNames) {
      const evidence = this.#database.getProviderCache<InventoryBasePrice>(priceCacheKey(this.#source.provider, name), now);
      if (evidence?.data && isInventoryBasePrice(evidence.data)) cached.push(evidence.data);
      else missing.push(name);
    }
    if (missing.length === 0) return { prices: cached, limitations: [] };

    const limitations: string[] = [];
    const batch = missing.slice(0, this.#source.batchLimit);
    if (missing.length > batch.length) {
      limitations.push(
        `本轮还有 ${missing.length - batch.length} 个类目未查询价格；批量接口额度有限，将在后续轮次继续补齐缓存。`,
      );
    }
    const cooldownKey = `inventory-valuation:batch-cooldown:${this.#source.provider}`;
    const coolingDown = this.#source.minimumBatchIntervalMs > 0
      ? this.#database.getProviderCache<{ readonly requested: true }>(cooldownKey, now)
      : undefined;
    if (coolingDown) {
      limitations.push("价格批量接口仍在限流冷却期，本轮只使用尚未过期的本地缓存。");
      return { prices: cached, limitations };
    }
    if (this.#source.minimumBatchIntervalMs > 0) {
      const marker: Evidence<{ readonly requested: true }> = {
        source: `${this.#source.provider}:batch-cooldown`,
        observedAt: now.toISOString(),
        confidence: "verified_source",
        limitations: [],
        data: { requested: true },
      };
      this.#database.saveProviderCache(
        cooldownKey,
        this.#source.provider,
        marker,
        new Date(now.valueOf() + this.#source.minimumBatchIntervalMs).toISOString(),
      );
    }
    try {
      const fetched = await this.#source.fetch(batch);
      const expiresAt = new Date(now.valueOf() + this.#cacheTtlMs).toISOString();
      for (const price of fetched) {
        const evidence: Evidence<InventoryBasePrice> = {
          source: price.source,
          observedAt: price.priceObservedAt,
          confidence: "verified_source",
          limitations: ["Cached BUFF base-category listing price for local inventory valuation."],
          data: price,
        };
        this.#database.saveProviderCache(
          priceCacheKey(this.#source.provider, price.marketHashName),
          this.#source.provider,
          evidence,
          expiresAt,
        );
      }
      return { prices: mergePrices(cached, fetched), limitations };
    } catch (error) {
      limitations.push(`BUFF 价格查询失败，本轮只使用缓存：${describeError(error)}`);
      return { prices: cached, limitations };
    }
  }
}

function adapterSource(adapter: MarketDataAdapter): InventoryBuffPriceSource {
  const policy = adapter.descriptor.batchPolicy;
  if (!adapter.getBatchQuotes || !policy) return missingSource();
  return {
    provider: adapter.descriptor.id,
    batchLimit: policy.maximumItems,
    minimumBatchIntervalMs: policy.minimumIntervalMs,
    async fetch(names) {
      const evidence = await adapter.getBatchQuotes!(names);
      const byName = new Map<string, InventoryBasePrice>();
      for (const quote of evidence.data) {
        if (quote.provider !== adapter.descriptor.id || quote.platform.trim().toUpperCase() !== "BUFF") continue;
        if (quote.sellPrice === undefined || quote.sellPrice <= 0) continue;
        byName.set(quote.marketHashName.toLocaleLowerCase(), {
          marketHashName: quote.marketHashName,
          unitPrice: quote.sellPrice,
          priceObservedAt: quote.observedAt,
          source: quote.source || evidence.source,
        });
      }
      return [...byName.values()];
    },
  };
}

function missingSource(): never {
  throw new Error("InventoryValuationService requires SteamDT or CSQAQ market data.");
}

function priceCacheKey(provider: InventoryValuationProvider, marketHashName: string): string {
  return `inventory-valuation:${provider}:BUFF:${marketHashName.toLocaleLowerCase()}`;
}

function mergePrices(
  cached: readonly InventoryBasePrice[],
  fetched: readonly InventoryBasePrice[],
): readonly InventoryBasePrice[] {
  const prices = new Map(cached.map((price) => [price.marketHashName.toLocaleLowerCase(), price]));
  for (const price of fetched) prices.set(price.marketHashName.toLocaleLowerCase(), price);
  return [...prices.values()];
}

function isInventoryBasePrice(value: unknown): value is InventoryBasePrice {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return typeof record.marketHashName === "string" &&
    typeof record.unitPrice === "number" &&
    Number.isFinite(record.unitPrice) &&
    typeof record.priceObservedAt === "string" &&
    typeof record.source === "string";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown provider failure";
}
