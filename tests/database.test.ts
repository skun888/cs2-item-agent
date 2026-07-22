import assert from "node:assert/strict";
import test from "node:test";

import { verifiedEvidence } from "../src/domain/evidence.js";
import { AppDatabase } from "../src/storage/database.js";

test("database migrations are idempotent and market observations are append-only", () => {
  const database = new AppDatabase(":memory:");

  assert.deepEqual(database.migrate(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(database.migrate(), []);

  const evidence = verifiedEvidence(
    "steamdt:price-single",
    new Date("2026-07-20T00:00:00.000Z"),
    [
      {
        platform: "SYNTHETIC_PLATFORM",
        sellPrice: 12.34,
        sellCount: 56,
        raw: { platform: "SYNTHETIC_PLATFORM", sellPrice: 12.34, sellCount: 56 },
      },
    ],
  );

  assert.equal(database.savePriceEvidence("Synthetic Item", evidence), 1);
  assert.equal(database.savePriceEvidence("Synthetic Item", evidence), 1);
  assert.equal(database.saveNormalizedMarketQuotes([
    {
      marketHashName: "Synthetic Item",
      platform: "SYNTHETIC_PLATFORM",
      provider: "csqaq",
      source: "csqaq:batch-prices",
      observedAt: "2026-07-20T01:00:00.000Z",
      currency: "CNY",
      sellPrice: 99,
    },
  ]), 1);
  assert.equal(database.countRows("market_items"), 1);
  assert.equal(database.countRows("market_snapshots"), 3);
  assert.equal(database.getLatestPriceEvidence("Synthetic Item")?.source, "steamdt:price-single");
  const cached = verifiedEvidence("csqaq:test", new Date("2026-07-20T00:00:00.000Z"), { value: 42 }, ["limited"]);
  database.saveProviderCache("test:key", "csqaq", cached, "2026-07-21T00:00:00.000Z");
  assert.deepEqual(database.getProviderCache<{ value: number }>("test:key", new Date("2026-07-20T12:00:00.000Z"))?.data, { value: 42 });
  assert.equal(database.getProviderCache("test:key", new Date("2026-07-22T00:00:00.000Z")), undefined);
  assert.equal(database.countRows("provider_cache"), 1);
  database.close();
});
