import assert from "node:assert/strict";
import test from "node:test";

import type { SteamDtKlinePoint, SteamDtPriceEntry } from "../src/adapters/steamdt/types.js";
import { analyzeMarket } from "../src/domain/market-analysis.js";
import { verifiedEvidence } from "../src/domain/evidence.js";

test("market analysis excludes zero placeholders and calculates transparent indicators", () => {
  const itemPoints = makeKline(100, 0.0005);
  const broadPoints = makeKline(1000, 0.00005);
  const latestTimestamp = itemPoints.at(-1)!.timestamp;
  const generatedAt = new Date(latestTimestamp * 1000);
  const prices: readonly SteamDtPriceEntry[] = [
    {
      platform: "PLATFORM_A",
      sellPrice: 10,
      sellCount: 100,
      biddingPrice: 9.5,
      biddingCount: 50,
      updateTime: latestTimestamp,
      raw: {},
    },
    {
      platform: "PLATFORM_B",
      sellPrice: 12,
      sellCount: 200,
      biddingPrice: 11,
      biddingCount: 100,
      updateTime: latestTimestamp,
      raw: {},
    },
    {
      platform: "ZERO_PLACEHOLDER",
      sellPrice: 0,
      sellCount: 0,
      biddingPrice: 0,
      biddingCount: 0,
      updateTime: latestTimestamp - 200_000,
      raw: {},
    },
    {
      platform: "CROSSED_BOOK",
      sellPrice: 8,
      sellCount: 10,
      biddingPrice: 20,
      biddingCount: 9999,
      updateTime: latestTimestamp,
      raw: {},
    },
  ];
  const previousPrices: readonly SteamDtPriceEntry[] = [
    { platform: "PLATFORM_A", sellPrice: 10, sellCount: 80, biddingCount: 40, raw: {} },
    { platform: "PLATFORM_B", sellPrice: 12, sellCount: 160, biddingCount: 80, raw: {} },
  ];

  const report = analyzeMarket({
    marketHashName: "Synthetic Item",
    platform: "PLATFORM_A",
    klineType: 1,
    generatedAt,
    prices: verifiedEvidence("synthetic:prices", generatedAt, prices),
    previousPrices: verifiedEvidence(
      "synthetic:prices",
      new Date(generatedAt.valueOf() - 60 * 60 * 1000),
      previousPrices,
    ),
    itemKline: verifiedEvidence("synthetic:item-kline", generatedAt, itemPoints),
    broadKline: verifiedEvidence("synthetic:broad-kline", generatedAt, broadPoints),
  });

  assert.deepEqual(report.currentMarket.lowestListing, { platform: "CROSSED_BOOK", price: 8 });
  assert.equal(report.currentMarket.highestBid?.platform, "PLATFORM_B");
  assert.equal(report.currentMarket.visibleListingCountSum, 310);
  assert.equal(report.currentMarket.visibleBidCountSum, 150);
  assert.equal(report.currentMarket.listingCountChangePct, 29.1667);
  assert.equal(report.currentMarket.bidCountChangePct, 25);
  assert.equal(report.dataQuality.unavailablePricePlatforms, 1);
  assert.ok(report.dataQuality.warnings.some((warning) => warning.includes("CROSSED_BOOK")));
  assert.equal(report.trend.label, "uptrend");
  assert.ok((report.trend.returnsPct.days7 ?? 0) > 0);
  assert.ok((report.relativeMarket.relativeStrength7dPctPoints ?? 0) > 0);
  assert.equal(report.relativeMarket.available, true);
  assert.match(report.narrativeZh.conclusion, /上行趋势/);
});

test("market analysis reports unknown relative strength when broad data is absent", () => {
  const points = makeKline(100, 0);
  const generatedAt = new Date(points.at(-1)!.timestamp * 1000);
  const report = analyzeMarket({
    marketHashName: "Synthetic Item",
    platform: "PLATFORM_A",
    klineType: 1,
    generatedAt,
    prices: verifiedEvidence("synthetic:prices", generatedAt, []),
    itemKline: verifiedEvidence("synthetic:item-kline", generatedAt, points),
    broadUnavailableReason: "provider denied",
  });

  assert.equal(report.relativeMarket.available, false);
  assert.equal(report.relativeMarket.unavailableReason, "provider denied");
  assert.equal(report.dataQuality.confidence, "low");
});

function makeKline(startPrice: number, growthPerPoint: number): readonly SteamDtKlinePoint[] {
  const start = 1_700_000_000;
  const points: SteamDtKlinePoint[] = [];
  for (let index = 0; index <= 35 * 12; index += 1) {
    const open = startPrice * (1 + growthPerPoint * index);
    const close = startPrice * (1 + growthPerPoint * (index + 1));
    const timestamp = start + index * 7200;
    const raw = [timestamp, open, close, Math.max(open, close), Math.min(open, close)] as const;
    points.push({
      timestamp,
      open,
      close,
      high: Math.max(open, close),
      low: Math.min(open, close),
      raw,
    });
  }
  return points;
}
