import type { InventoryFetchStatus, SteamInventoryAsset } from "../adapters/steam-inventory/types.js";
import type { InventoryValuationSnapshot } from "./inventory-valuation.js";

export type InventoryEventType = "observed_added" | "observed_removed" | "quantity_changed";

export interface StoredInventorySnapshot {
  readonly id: number;
  readonly steamId: string;
  readonly observedAt: string;
  readonly totalInventoryCount?: number;
  readonly assets: readonly SteamInventoryAsset[];
}

export interface InventoryChangeEvent {
  readonly eventType: InventoryEventType;
  readonly assetId: string;
  readonly marketHashName?: string;
  readonly displayName?: string;
  readonly quantityBefore: number;
  readonly quantityAfter: number;
  readonly previousObservedAt: string;
  readonly observedAt: string;
}

export interface InventoryCategoryChange {
  readonly marketHashName: string;
  readonly quantityBefore: number;
  readonly quantityAfter: number;
  readonly delta: number;
}

export interface InventoryHoldingSummary {
  readonly marketHashName: string;
  readonly quantity: number;
  readonly assetCount: number;
}

export interface InventoryAssetView {
  readonly assetId: string;
  readonly classId: string;
  readonly instanceId: string;
  readonly amount: number;
  readonly marketHashName?: string;
  readonly displayName?: string;
  readonly itemType?: string;
  readonly tradable?: boolean;
  readonly marketable?: boolean;
  readonly inspectLink?: string;
  readonly iconUrl?: string;
  readonly paintSeed?: number;
  readonly paintWear?: number;
  readonly paintWearBits?: number;
  readonly paintIndex?: number;
  readonly nameTag?: string;
  readonly charmTemplate?: number;
  readonly observationFingerprint?: string;
}

export interface LatestInventoryQueryResult {
  readonly steamId: string;
  readonly observedAt?: string;
  readonly status: "available" | "no_successful_snapshot";
  readonly filter?: string;
  readonly totalMatchingAssets: number;
  readonly returnedAssets: number;
  readonly assets: readonly InventoryAssetView[];
  readonly holdings: readonly InventoryHoldingSummary[];
  readonly limitations: readonly string[];
}

export interface InventoryHolderRankEntry {
  readonly steamId: string;
  readonly label?: string;
  readonly quantity: number;
  readonly assetCount: number;
  readonly observedAt: string;
}

export interface InventoryHolderRankResult {
  readonly marketHashName: string;
  readonly coverage: {
    readonly latestSuccessfulSnapshots: number;
    readonly matchingAccounts: number;
  };
  readonly holders: readonly InventoryHolderRankEntry[];
  readonly confidence: "verified_source" | "unknown";
  readonly limitations: readonly string[];
}

export interface InventoryPersistenceResult {
  readonly checkId: number;
  readonly snapshotId?: number;
  readonly baselineCreated: boolean;
  readonly previousObservedAt?: string;
  readonly events: readonly InventoryChangeEvent[];
  readonly categoryChanges: readonly InventoryCategoryChange[];
}

export interface InventoryCheckReport {
  readonly steamId: string;
  readonly source: "steam-community:public-inventory";
  readonly observedAt: string;
  readonly status: InventoryFetchStatus;
  readonly httpStatus?: number;
  readonly message?: string;
  readonly complete: boolean;
  readonly pageCount: number;
  readonly assetCount?: number;
  readonly totalInventoryCount?: number;
  readonly holdings: readonly InventoryHoldingSummary[];
  readonly baselineCreated: boolean;
  readonly previousObservedAt?: string;
  readonly changes: {
    readonly added: number;
    readonly removed: number;
    readonly quantityChanged: number;
    readonly events: readonly InventoryChangeEvent[];
    readonly categoryChanges: readonly InventoryCategoryChange[];
  };
  readonly confidence: "verified_source" | "unknown";
  readonly limitations: readonly string[];
  readonly valuation: {
    readonly status: "available" | "not_configured" | "skipped" | "failed";
    readonly data?: InventoryValuationSnapshot;
    readonly message?: string;
  };
  readonly notification?: {
    readonly status: "sent" | "skipped" | "failed";
    readonly message?: string;
  };
}

export interface InventoryWatch {
  readonly steamId: string;
  readonly label?: string;
  readonly enabled: boolean;
  readonly intervalMinutes: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastCheckedAt?: string;
  readonly nextCheckAt?: string;
}

export function diffInventorySnapshots(
  previous: StoredInventorySnapshot,
  currentAssets: readonly SteamInventoryAsset[],
  observedAt: string,
): readonly InventoryChangeEvent[] {
  const previousByAssetId = new Map(previous.assets.map((asset) => [asset.assetId, asset]));
  const currentByAssetId = new Map(currentAssets.map((asset) => [asset.assetId, asset]));
  const events: InventoryChangeEvent[] = [];

  for (const current of currentAssets) {
    const before = previousByAssetId.get(current.assetId);
    if (!before) {
      events.push(toEvent("observed_added", current, 0, current.amount, previous.observedAt, observedAt));
    } else if (before.amount !== current.amount) {
      events.push(
        toEvent("quantity_changed", current, before.amount, current.amount, previous.observedAt, observedAt),
      );
    }
  }

  for (const before of previous.assets) {
    if (!currentByAssetId.has(before.assetId)) {
      events.push(toEvent("observed_removed", before, before.amount, 0, previous.observedAt, observedAt));
    }
  }
  return events;
}

export function summarizeCategoryChanges(
  previous: StoredInventorySnapshot,
  currentAssets: readonly SteamInventoryAsset[],
): readonly InventoryCategoryChange[] {
  const before = countByMarketHashName(previous.assets);
  const after = countByMarketHashName(currentAssets);
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names]
    .map((marketHashName) => {
      const quantityBefore = before.get(marketHashName) ?? 0;
      const quantityAfter = after.get(marketHashName) ?? 0;
      return {
        marketHashName,
        quantityBefore,
        quantityAfter,
        delta: quantityAfter - quantityBefore,
      };
    })
    .filter((entry) => entry.delta !== 0)
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta));
}

export function summarizeInventoryHoldings(
  assets: readonly SteamInventoryAsset[],
): readonly InventoryHoldingSummary[] {
  const grouped = new Map<string, { quantity: number; assetCount: number }>();
  for (const asset of assets) {
    if (!asset.marketHashName) continue;
    const current = grouped.get(asset.marketHashName) ?? { quantity: 0, assetCount: 0 };
    current.quantity += asset.amount;
    current.assetCount += 1;
    grouped.set(asset.marketHashName, current);
  }
  return [...grouped]
    .map(([marketHashName, value]) => ({ marketHashName, ...value }))
    .sort((left, right) => right.quantity - left.quantity || left.marketHashName.localeCompare(right.marketHashName));
}

export function toInventoryAssetView(asset: SteamInventoryAsset): InventoryAssetView {
  return {
    assetId: asset.assetId,
    classId: asset.classId,
    instanceId: asset.instanceId,
    amount: asset.amount,
    ...(asset.marketHashName ? { marketHashName: asset.marketHashName } : {}),
    ...(asset.displayName ? { displayName: asset.displayName } : {}),
    ...(asset.itemType ? { itemType: asset.itemType } : {}),
    ...(asset.tradable !== undefined ? { tradable: asset.tradable } : {}),
    ...(asset.marketable !== undefined ? { marketable: asset.marketable } : {}),
    ...(asset.inspectLink ? { inspectLink: asset.inspectLink } : {}),
    ...(asset.iconUrl ? { iconUrl: asset.iconUrl } : {}),
    ...(asset.paintSeed !== undefined ? { paintSeed: asset.paintSeed } : {}),
    ...(asset.paintWear !== undefined ? { paintWear: asset.paintWear } : {}),
    ...(asset.paintWearBits !== undefined ? { paintWearBits: asset.paintWearBits } : {}),
    ...(asset.paintIndex !== undefined ? { paintIndex: asset.paintIndex } : {}),
    ...(asset.nameTag ? { nameTag: asset.nameTag } : {}),
    ...(asset.charmTemplate !== undefined ? { charmTemplate: asset.charmTemplate } : {}),
    ...(asset.observationFingerprint
      ? { observationFingerprint: asset.observationFingerprint }
      : {}),
  };
}

function countByMarketHashName(assets: readonly SteamInventoryAsset[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const asset of assets) {
    if (!asset.marketHashName) continue;
    counts.set(asset.marketHashName, (counts.get(asset.marketHashName) ?? 0) + asset.amount);
  }
  return counts;
}

function toEvent(
  eventType: InventoryEventType,
  asset: SteamInventoryAsset,
  quantityBefore: number,
  quantityAfter: number,
  previousObservedAt: string,
  observedAt: string,
): InventoryChangeEvent {
  return {
    eventType,
    assetId: asset.assetId,
    ...(asset.marketHashName ? { marketHashName: asset.marketHashName } : {}),
    ...(asset.displayName ? { displayName: asset.displayName } : {}),
    quantityBefore,
    quantityAfter,
    previousObservedAt,
    observedAt,
  };
}
