import assert from "node:assert/strict";
import test from "node:test";

import {
  compareProviderQuotes,
  normalizeCsQaqPersonalPriceData,
  normalizeSteamDtPrices,
} from "../src/domain/market-quote.js";

test("SteamDT and CSQAQ prices normalize without overwriting provider provenance", () => {
  const fetchedAt = new Date("2026-07-20T00:00:00.000Z");
  const steamDt = normalizeSteamDtPrices(
    "Danger Zone Case",
    [
      {
        platform: "BUFF",
        sellPrice: 10,
        sellCount: 100,
        biddingPrice: 9.5,
        updateTime: 1_700_000_000_000,
        raw: {},
      },
    ],
    fetchedAt,
  );
  const csQaq = normalizeCsQaqPersonalPriceData(
    {
      success: {
        "Danger Zone Case": {
          goodId: 123,
          marketHashName: "Danger Zone Case",
          buffSellPrice: 11,
          buffSellNum: 90,
          yyypSellPrice: 10.5,
          yyypSellNum: 80,
          steamSellPrice: 16,
          steamSellNum: 70,
        },
      },
      error: [],
    },
    fetchedAt,
  );

  assert.equal(csQaq.length, 3);
  const comparison = compareProviderQuotes([...steamDt, ...csQaq]).find(
    (entry) => entry.platform === "BUFF",
  );
  assert.equal(comparison?.quotes.length, 2);
  assert.deepEqual(comparison?.quotes.map((quote) => quote.provider), ["steamdt", "csqaq"]);
  assert.equal(comparison?.sellPriceDifferenceRate, 0.1);
  const singleSource = compareProviderQuotes([steamDt[0]!]);
  assert.equal(singleSource[0]?.sellPriceDifferenceRate, undefined);
});
