import type { SteamInventoryAsset } from "../adapters/steam-inventory/types.js";

/** Stable market adapter id used for the valuation price evidence. */
export type InventoryValuationProvider = string;

export interface InventoryBasePrice {
  readonly marketHashName: string;
  readonly unitPrice: number;
  readonly priceObservedAt: string;
  readonly source: string;
}

export interface InventoryValuationItem {
  readonly marketHashName: string;
  readonly quantity: number;
  readonly itemType?: string;
  readonly unitPrice?: number;
  readonly knownValue?: number;
  readonly priceObservedAt?: string;
  readonly source?: string;
}

export interface InventoryValuationSnapshot {
  readonly id?: number;
  readonly snapshotId: number;
  readonly steamId: string;
  readonly provider: InventoryValuationProvider;
  readonly platform: "BUFF";
  readonly inventoryObservedAt: string;
  readonly valuedAt: string;
  readonly eligibleQuantity: number;
  readonly pricedQuantity: number;
  readonly unknownQuantity: number;
  readonly eligibleCategoryCount: number;
  readonly pricedCategoryCount: number;
  readonly priceCoverage: number;
  readonly categoryCoverage: number;
  readonly knownSubtotal: number;
  readonly previousValuationId?: number;
  readonly previousKnownSubtotal?: number;
  readonly compositionDelta?: number;
  readonly compositionDeltaRate?: number;
  readonly marketPriceDelta?: number;
  readonly highValueEventCount: number;
  readonly highValueAlertEligible: boolean;
  readonly items: readonly InventoryValuationItem[];
  readonly limitations: readonly string[];
}

export interface HighValueInventoryEvent {
  readonly eventType: "high_value_added" | "high_value_removed" | "high_value_quantity_changed";
  readonly assetId: string;
  readonly marketHashName: string;
  readonly quantityBefore: number;
  readonly quantityAfter: number;
  readonly unitPrice: number;
  readonly estimatedDelta: number;
  readonly observedAt: string;
}

export interface InventoryValuationThresholds {
  readonly singleItemValue: number;
  readonly totalChangeAmount: number;
  readonly totalChangeRate: number;
  readonly minimumPriceCoverage: number;
}

export const DEFAULT_INVENTORY_VALUATION_THRESHOLDS: InventoryValuationThresholds = {
  singleItemValue: 1_000,
  totalChangeAmount: 10_000,
  totalChangeRate: 0.2,
  minimumPriceCoverage: 0.9,
};

export function aggregateValuationEligibleAssets(
  assets: readonly SteamInventoryAsset[],
): readonly InventoryValuationItem[] {
  const grouped = new Map<string, { quantity: number; itemType?: string }>();
  for (const asset of assets) {
    const marketHashName = asset.marketHashName?.trim();
    if (!marketHashName || asset.marketable === false) continue;
    const current = grouped.get(marketHashName);
    grouped.set(marketHashName, {
      quantity: (current?.quantity ?? 0) + asset.amount,
      ...(current?.itemType || asset.itemType ? { itemType: current?.itemType ?? asset.itemType } : {}),
    });
  }
  return [...grouped.entries()]
    .map(([marketHashName, value]) => ({ marketHashName, ...value }))
    .sort((left, right) => left.marketHashName.localeCompare(right.marketHashName));
}

export function calculateInventoryValuation(input: {
  readonly snapshotId: number;
  readonly steamId: string;
  readonly provider: InventoryValuationProvider;
  readonly inventoryObservedAt: string;
  readonly valuedAt: string;
  readonly assets: readonly SteamInventoryAsset[];
  readonly prices: readonly InventoryBasePrice[];
  readonly previous?: InventoryValuationSnapshot;
  readonly highValueEventCount?: number;
  readonly thresholds?: InventoryValuationThresholds;
  readonly limitations?: readonly string[];
}): InventoryValuationSnapshot {
  const thresholds = input.thresholds ?? DEFAULT_INVENTORY_VALUATION_THRESHOLDS;
  const prices = new Map(input.prices.map((price) => [price.marketHashName.toLocaleLowerCase(), price]));
  const items = aggregateValuationEligibleAssets(input.assets).map((item): InventoryValuationItem => {
    const price = prices.get(item.marketHashName.toLocaleLowerCase());
    return {
      ...item,
      ...(price
        ? {
            unitPrice: price.unitPrice,
            knownValue: roundMoney(item.quantity * price.unitPrice),
            priceObservedAt: price.priceObservedAt,
            source: price.source,
          }
        : {}),
    };
  });
  const eligibleQuantity = sum(items.map((item) => item.quantity));
  const priced = items.filter((item) => item.unitPrice !== undefined && item.knownValue !== undefined);
  const pricedQuantity = sum(priced.map((item) => item.quantity));
  const knownSubtotal = roundMoney(sum(priced.map((item) => item.knownValue ?? 0)));
  const previousItems = new Map(
    (input.previous?.items ?? []).map((item) => [item.marketHashName.toLocaleLowerCase(), item]),
  );
  let compositionDelta: number | undefined;
  let marketPriceDelta: number | undefined;
  let compositionDeltaRate: number | undefined;
  if (input.previous) {
    let composition = 0;
    let market = 0;
    let compositionComplete = true;
    for (const name of new Set([...items.map((item) => item.marketHashName.toLocaleLowerCase()), ...previousItems.keys()])) {
      const current = items.find((item) => item.marketHashName.toLocaleLowerCase() === name);
      const previous = previousItems.get(name);
      const currentQuantity = current?.quantity ?? 0;
      const previousQuantity = previous?.quantity ?? 0;
      const currentPrice = current?.unitPrice ?? prices.get(name)?.unitPrice;
      if (currentQuantity !== previousQuantity) {
        if (currentPrice === undefined) compositionComplete = false;
        else composition += (currentQuantity - previousQuantity) * currentPrice;
      }
      if (previousQuantity > 0 && currentPrice !== undefined && previous?.unitPrice !== undefined) {
        market += previousQuantity * (currentPrice - previous.unitPrice);
      }
    }
    if (compositionComplete) {
      compositionDelta = roundMoney(composition);
      if ((input.previous.knownSubtotal ?? 0) > 0) {
        compositionDeltaRate = compositionDelta / input.previous.knownSubtotal;
      }
    }
    marketPriceDelta = roundMoney(market);
  }
  const priceCoverage = eligibleQuantity > 0 ? pricedQuantity / eligibleQuantity : 1;
  const categoryCoverage = items.length > 0 ? priced.length / items.length : 1;
  const highValueAlertEligible = Boolean(
    input.previous &&
    compositionDelta !== undefined &&
    compositionDeltaRate !== undefined &&
    priceCoverage >= thresholds.minimumPriceCoverage &&
    input.previous.priceCoverage >= thresholds.minimumPriceCoverage &&
    Math.abs(compositionDelta) >= thresholds.totalChangeAmount &&
    Math.abs(compositionDeltaRate) >= thresholds.totalChangeRate
  );
  return {
    snapshotId: input.snapshotId,
    steamId: input.steamId,
    provider: input.provider,
    platform: "BUFF",
    inventoryObservedAt: input.inventoryObservedAt,
    valuedAt: input.valuedAt,
    eligibleQuantity,
    pricedQuantity,
    unknownQuantity: eligibleQuantity - pricedQuantity,
    eligibleCategoryCount: items.length,
    pricedCategoryCount: priced.length,
    priceCoverage,
    categoryCoverage,
    knownSubtotal,
    ...(input.previous?.id !== undefined ? { previousValuationId: input.previous.id } : {}),
    ...(input.previous ? { previousKnownSubtotal: input.previous.knownSubtotal } : {}),
    ...(compositionDelta !== undefined ? { compositionDelta } : {}),
    ...(compositionDeltaRate !== undefined ? { compositionDeltaRate } : {}),
    ...(marketPriceDelta !== undefined ? { marketPriceDelta } : {}),
    highValueEventCount: input.highValueEventCount ?? 0,
    highValueAlertEligible,
    items,
    limitations: [
      "估值只采用 BUFF 最低在售价的基础类目价格，不代表立即可成交价格。",
      "特殊模板、极限磨损、贴纸、名称标签及其他溢价未计入估值。",
      "缺少价格的物品保持未知，不按 0 元计算。",
      ...(input.previous && (priceCoverage < 1 || input.previous.priceCoverage < 1)
        ? ["市场价格影响只覆盖前后均有价格的可比类目，不代表完整库存的价格变化。"]
        : []),
      ...(input.limitations ?? []),
    ],
  };
}

export function buildHighValueInventoryEvents(input: {
  readonly inventoryEvents: readonly {
    readonly eventType: "observed_added" | "observed_removed" | "quantity_changed";
    readonly assetId: string;
    readonly marketHashName?: string;
    readonly quantityBefore: number;
    readonly quantityAfter: number;
    readonly observedAt: string;
  }[];
  readonly prices: readonly InventoryBasePrice[];
  readonly threshold?: number;
}): readonly HighValueInventoryEvent[] {
  const threshold = input.threshold ?? DEFAULT_INVENTORY_VALUATION_THRESHOLDS.singleItemValue;
  const prices = new Map(input.prices.map((price) => [price.marketHashName.toLocaleLowerCase(), price.unitPrice]));
  return input.inventoryEvents.flatMap((event): readonly HighValueInventoryEvent[] => {
    if (!event.marketHashName) return [];
    const unitPrice = prices.get(event.marketHashName.toLocaleLowerCase());
    if (unitPrice === undefined || unitPrice < threshold) return [];
    return [{
      eventType: event.eventType === "observed_added"
        ? "high_value_added"
        : event.eventType === "observed_removed"
          ? "high_value_removed"
          : "high_value_quantity_changed",
      assetId: event.assetId,
      marketHashName: event.marketHashName,
      quantityBefore: event.quantityBefore,
      quantityAfter: event.quantityAfter,
      unitPrice,
      estimatedDelta: roundMoney((event.quantityAfter - event.quantityBefore) * unitPrice),
      observedAt: event.observedAt,
    }];
  });
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
