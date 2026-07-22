import assert from "node:assert/strict";
import test from "node:test";

import type {
  MarketAdapterDescriptor,
  MarketDataAdapter,
} from "../src/adapters/market/contract.js";
import { MarketAdapterRegistry } from "../src/adapters/market/registry.js";
import { AppError } from "../src/core/errors.js";
import { verifiedEvidence } from "../src/domain/evidence.js";
import type { NormalizedMarketQuote } from "../src/domain/market-quote.js";
import { InventoryValuationService } from "../src/services/inventory-valuation-service.js";
import { MarketCompatibilityService } from "../src/services/market-compatibility-service.js";
import { AppDatabase } from "../src/storage/database.js";

const OBSERVED_AT = new Date("2026-07-22T00:00:00.000Z");
const CUSTOM_DESCRIPTOR: MarketAdapterDescriptor = {
  id: "buff-direct",
  displayName: "BUFF licensed adapter",
  kind: "direct_platform",
  priority: 10,
  capabilities: ["market_quotes", "batch_market_quotes"],
  platforms: ["BUFF"],
  batchPolicy: { maximumItems: 20, minimumIntervalMs: 0 },
};

test("registry isolates adapter failures and keeps unconfigured capability metadata", async () => {
  const adapter = customAdapter();
  const failedDescriptor: MarketAdapterDescriptor = {
    id: "failed-source",
    displayName: "Failed source",
    kind: "direct_platform",
    priority: 20,
    capabilities: ["market_quotes"],
    platforms: ["BUFF"],
  };
  const failed: MarketDataAdapter = {
    descriptor: failedDescriptor,
    async getQuotes() {
      throw new AppError("PROVIDER_ERROR", "synthetic failure");
    },
  };
  const registry = new MarketAdapterRegistry([
    { descriptor: CUSTOM_DESCRIPTOR, adapter },
    { descriptor: failedDescriptor, adapter: failed },
    {
      descriptor: {
        id: "future-source",
        displayName: "Future source",
        kind: "aggregator",
        priority: 30,
        capabilities: ["market_quotes"],
        platforms: "provider_defined",
      },
    },
  ]);

  const report = await registry.fetchAllQuotes("Synthetic Skin");

  assert.equal(report.quotes.length, 1);
  assert.equal(report.quotes[0]?.provider, "buff-direct");
  assert.deepEqual(report.providers.map((entry) => entry.status), ["available", "failed", "not_configured"]);
  assert.match(report.providers[1]?.error ?? "", /PROVIDER_ERROR/);
  assert.equal(registry.health()[2]?.configured, false);
});

test("custom adapter works in comparison and inventory valuation without service changes", async () => {
  const registry = new MarketAdapterRegistry([{ descriptor: CUSTOM_DESCRIPTOR, adapter: customAdapter() }]);
  const database = new AppDatabase(":memory:");
  const compatibility = new MarketCompatibilityService(registry, database, () => OBSERVED_AT);
  const prices = await compatibility.comparePrices("Synthetic Skin");
  assert.equal(prices.providers[0]?.provider, "buff-direct");
  assert.equal(database.countRows("market_snapshots"), 1);

  const inventory = database.saveInventoryFetchResult({
    source: "steam-community:public-inventory",
    steamId: "76561198000000000",
    observedAt: OBSERVED_AT.toISOString(),
    status: "public",
    assets: [{
      assetId: "1",
      classId: "class-1",
      instanceId: "0",
      contextId: "2",
      amount: 1,
      marketHashName: "Synthetic Skin",
      displayName: "Synthetic Skin",
      tradable: true,
      marketable: true,
      raw: {},
    }],
    totalInventoryCount: 1,
    pageCount: 1,
    complete: true,
  });
  assert.ok(inventory.snapshotId);
  const valuation = await new InventoryValuationService(database, {
    registry,
    now: () => OBSERVED_AT,
  }).valueSnapshot({
    snapshotId: inventory.snapshotId,
    steamId: "76561198000000000",
    inventoryObservedAt: OBSERVED_AT.toISOString(),
    assets: [{
      assetId: "1",
      classId: "class-1",
      instanceId: "0",
      contextId: "2",
      amount: 1,
      marketHashName: "Synthetic Skin",
      displayName: "Synthetic Skin",
      tradable: true,
      marketable: true,
      raw: {},
    }],
    inventoryEvents: [],
  });
  assert.equal(valuation.provider, "buff-direct");
  assert.equal(valuation.knownSubtotal, 123.45);
  assert.equal(database.getLatestInventoryValuation("76561198000000000")?.provider, "buff-direct");
  database.close();
});

test("registry rejects duplicate ids and mismatched quote attribution", async () => {
  assert.throws(
    () => new MarketAdapterRegistry([
      { descriptor: CUSTOM_DESCRIPTOR, adapter: customAdapter() },
      { descriptor: CUSTOM_DESCRIPTOR, adapter: customAdapter() },
    ]),
    /Duplicate market adapter id/,
  );
  const wrong = customAdapter("another-source");
  const registry = new MarketAdapterRegistry([{ descriptor: CUSTOM_DESCRIPTOR, adapter: wrong }]);
  await assert.rejects(() => registry.fetchAllQuotes("Synthetic Skin"), /attributed to another-source/);
});

function customAdapter(quoteProvider = CUSTOM_DESCRIPTOR.id): MarketDataAdapter {
  const quote = (marketHashName: string): NormalizedMarketQuote => ({
    marketHashName,
    platform: "BUFF",
    provider: quoteProvider,
    source: `${quoteProvider}:price`,
    observedAt: OBSERVED_AT.toISOString(),
    currency: "CNY",
    sellPrice: 123.45,
    sellCount: 10,
  });
  return {
    descriptor: CUSTOM_DESCRIPTOR,
    async getQuotes(marketHashName) {
      return verifiedEvidence(`${quoteProvider}:price`, OBSERVED_AT, [quote(marketHashName)], []);
    },
    async getBatchQuotes(marketHashNames) {
      return verifiedEvidence(`${quoteProvider}:batch`, OBSERVED_AT, marketHashNames.map(quote), []);
    },
  };
}
