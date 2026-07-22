import assert from "node:assert/strict";
import test from "node:test";

import { CsQaqClient } from "../src/adapters/csqaq/client.js";
import { SteamDtClient } from "../src/adapters/steamdt/client.js";
import { MarketCompatibilityService } from "../src/services/market-compatibility-service.js";
import { AppDatabase } from "../src/storage/database.js";

test("multi-source service retains SteamDT and CSQAQ as separate observations", async () => {
  const fixedNow = () => new Date("2026-07-20T00:00:00.000Z");
  const steamDt = new SteamDtClient({
    apiKey: "steamdt-test",
    now: fixedNow,
    fetchImpl: async () => Response.json({
      success: true,
      data: [{ platform: "BUFF", sellPrice: 10, sellCount: 100, updateTime: 1_700_000_000_000 }],
    }),
  });
  const csQaq = new CsQaqClient({
    apiToken: "csqaq-test",
    now: fixedNow,
    fetchImpl: async () => Response.json({
      code: 200,
      msg: "Success",
      data: {
        success: {
          "Danger Zone Case": {
            goodId: 123,
            marketHashName: "Danger Zone Case",
            buffSellPrice: 11,
            buffSellNum: 90,
          },
        },
        error: [],
      },
    }),
  });
  const database = new AppDatabase(":memory:");
  const service = new MarketCompatibilityService(steamDt, csQaq, database, fixedNow);

  const report = await service.comparePrices("Danger Zone Case");

  assert.deepEqual(report.providers.map((entry) => entry.status), ["available", "available"]);
  assert.deepEqual(report.quotes.map((entry) => entry.provider), ["steamdt", "csqaq"]);
  assert.equal(report.comparisons[0]?.sellPriceDifferenceRate, 0.1);
  assert.equal(database.countRows("market_snapshots"), 2);
  database.close();
});
