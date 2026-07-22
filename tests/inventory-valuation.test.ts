import assert from "node:assert/strict";
import test from "node:test";

import type { SteamInventoryAsset } from "../src/adapters/steam-inventory/types.js";
import { SteamDtClient } from "../src/adapters/steamdt/client.js";
import {
  buildHighValueInventoryEvents,
  calculateInventoryValuation,
} from "../src/domain/inventory-valuation.js";
import { AppDatabase } from "../src/storage/database.js";
import { InventoryValuationService } from "../src/services/inventory-valuation-service.js";

const STEAM_ID = "76561198000000000";

test("inventory valuation separates composition and market-price effects and applies dual threshold", () => {
  const previous = calculateInventoryValuation({
    snapshotId: 1,
    steamId: STEAM_ID,
    provider: "steamdt",
    inventoryObservedAt: "2026-07-20T00:00:00.000Z",
    valuedAt: "2026-07-20T00:00:01.000Z",
    assets: [asset("1", "High Skin", 20)],
    prices: [{ marketHashName: "High Skin", unitPrice: 1_000, priceObservedAt: "2026-07-20T00:00:00.000Z", source: "test" }],
  });
  const current = calculateInventoryValuation({
    snapshotId: 2,
    steamId: STEAM_ID,
    provider: "steamdt",
    inventoryObservedAt: "2026-07-20T00:30:00.000Z",
    valuedAt: "2026-07-20T00:30:01.000Z",
    assets: [asset("1", "High Skin", 30)],
    prices: [{ marketHashName: "High Skin", unitPrice: 1_100, priceObservedAt: "2026-07-20T00:30:00.000Z", source: "test" }],
    previous: { ...previous, id: 1 },
  });
  assert.equal(current.knownSubtotal, 33_000);
  assert.equal(current.compositionDelta, 11_000);
  assert.equal(current.compositionDeltaRate, 0.55);
  assert.equal(current.marketPriceDelta, 2_000);
  assert.equal(current.highValueAlertEligible, true);
});

test("price coverage below 90 percent blocks total high-value anomaly and missing prices stay unknown", () => {
  const previous = calculateInventoryValuation({
    snapshotId: 1,
    steamId: STEAM_ID,
    provider: "steamdt",
    inventoryObservedAt: "2026-07-20T00:00:00.000Z",
    valuedAt: "2026-07-20T00:00:01.000Z",
    assets: [asset("1", "Known", 8), asset("2", "Unknown", 2)],
    prices: [{ marketHashName: "Known", unitPrice: 2_000, priceObservedAt: "2026-07-20T00:00:00.000Z", source: "test" }],
  });
  const current = calculateInventoryValuation({
    snapshotId: 2,
    steamId: STEAM_ID,
    provider: "steamdt",
    inventoryObservedAt: "2026-07-20T00:30:00.000Z",
    valuedAt: "2026-07-20T00:30:01.000Z",
    assets: [asset("1", "Known", 20), asset("2", "Unknown", 5)],
    prices: [{ marketHashName: "Known", unitPrice: 2_000, priceObservedAt: "2026-07-20T00:30:00.000Z", source: "test" }],
    previous: { ...previous, id: 1 },
  });
  assert.equal(current.priceCoverage, 0.8);
  assert.equal(current.unknownQuantity, 5);
  assert.equal(current.highValueAlertEligible, false);
  assert.equal(current.items.find((item) => item.marketHashName === "Unknown")?.knownValue, undefined);
});

test("single items at least 1000 CNY create local high-value events but do not set the total alert alone", () => {
  const events = buildHighValueInventoryEvents({
    inventoryEvents: [{
      eventType: "observed_added",
      assetId: "asset-high",
      marketHashName: "High Skin",
      quantityBefore: 0,
      quantityAfter: 1,
      observedAt: "2026-07-20T00:30:00.000Z",
    }, {
      eventType: "observed_added",
      assetId: "asset-low",
      marketHashName: "Low Skin",
      quantityBefore: 0,
      quantityAfter: 1,
      observedAt: "2026-07-20T00:30:00.000Z",
    }],
    prices: [
      { marketHashName: "High Skin", unitPrice: 1_000, priceObservedAt: "2026-07-20T00:30:00.000Z", source: "test" },
      { marketHashName: "Low Skin", unitPrice: 999, priceObservedAt: "2026-07-20T00:30:00.000Z", source: "test" },
    ],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.marketHashName, "High Skin");
});

test("inventory valuation persists item coverage and high-value events", () => {
  const database = new AppDatabase(":memory:");
  database.migrate();
  const check = database.saveInventoryFetchResult({
    source: "steam-community:public-inventory",
    steamId: STEAM_ID,
    observedAt: "2026-07-20T00:00:00.000Z",
    status: "public",
    assets: [asset("1", "High Skin", 1)],
    totalInventoryCount: 1,
    pageCount: 1,
    complete: true,
  });
  assert.ok(check.snapshotId);
  const valuation = calculateInventoryValuation({
    snapshotId: check.snapshotId,
    steamId: STEAM_ID,
    provider: "steamdt",
    inventoryObservedAt: "2026-07-20T00:00:00.000Z",
    valuedAt: "2026-07-20T00:00:01.000Z",
    assets: [asset("1", "High Skin", 1)],
    prices: [{ marketHashName: "High Skin", unitPrice: 1_200, priceObservedAt: "2026-07-20T00:00:00.000Z", source: "test" }],
  });
  database.saveInventoryValuation(valuation, [{
    eventType: "high_value_added",
    assetId: "1",
    marketHashName: "High Skin",
    quantityBefore: 0,
    quantityAfter: 1,
    unitPrice: 1_200,
    estimatedDelta: 1_200,
    observedAt: "2026-07-20T00:00:00.000Z",
  }]);
  const stored = database.getLatestInventoryValuation(STEAM_ID);
  assert.equal(stored?.knownSubtotal, 1_200);
  assert.equal(stored?.items[0]?.unitPrice, 1_200);
  assert.equal(database.countRows("inventory_valuations"), 1);
  assert.equal(database.countRows("high_value_inventory_events"), 1);
  database.close();
});

test("valuation service batches BUFF prices once and reuses the 30-minute local cache", async () => {
  let requestCount = 0;
  const database = new AppDatabase(":memory:");
  const client = new SteamDtClient({
    apiKey: "test-key",
    now: () => new Date("2026-07-20T00:00:00.000Z"),
    fetchImpl: async () => {
      requestCount += 1;
      return Response.json({
        success: true,
        data: [{
          marketHashName: "High Skin",
          dataList: [{ platform: "BUFF", sellPrice: 1_200, updateTime: 1_784_512_000 }],
        }],
      });
    },
  });
  const service = new InventoryValuationService(database, {
    steamDt: client,
    now: () => new Date("2026-07-20T00:00:00.000Z"),
  });
  const firstCheck = database.saveInventoryFetchResult({
    source: "steam-community:public-inventory",
    steamId: STEAM_ID,
    observedAt: "2026-07-20T00:00:00.000Z",
    status: "public",
    assets: [asset("1", "High Skin", 1)],
    totalInventoryCount: 1,
    pageCount: 1,
    complete: true,
  });
  assert.ok(firstCheck.snapshotId);
  await service.valueSnapshot({
    snapshotId: firstCheck.snapshotId,
    steamId: STEAM_ID,
    inventoryObservedAt: "2026-07-20T00:00:00.000Z",
    assets: [asset("1", "High Skin", 1)],
    inventoryEvents: [],
  });
  const secondCheck = database.saveInventoryFetchResult({
    source: "steam-community:public-inventory",
    steamId: STEAM_ID,
    observedAt: "2026-07-20T00:10:00.000Z",
    status: "public",
    assets: [asset("1", "High Skin", 2)],
    totalInventoryCount: 1,
    pageCount: 1,
    complete: true,
  });
  assert.ok(secondCheck.snapshotId);
  const second = await service.valueSnapshot({
    snapshotId: secondCheck.snapshotId,
    steamId: STEAM_ID,
    inventoryObservedAt: "2026-07-20T00:10:00.000Z",
    assets: [asset("1", "High Skin", 2)],
    inventoryEvents: secondCheck.events,
  });
  assert.equal(requestCount, 1);
  assert.equal(second.knownSubtotal, 2_400);
  assert.equal(second.highValueEventCount, 1);
  database.close();
});

function asset(assetId: string, marketHashName: string, amount: number): SteamInventoryAsset {
  return {
    assetId,
    classId: `class-${assetId}`,
    instanceId: "0",
    contextId: "2",
    amount,
    marketHashName,
    displayName: marketHashName,
    itemType: "Synthetic",
    tradable: true,
    marketable: true,
    raw: {},
  };
}
