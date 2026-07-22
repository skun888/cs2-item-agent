import assert from "node:assert/strict";
import test from "node:test";

import type { MarketAnalysisReport } from "../src/domain/market-analysis.js";
import { assessMarketTrading } from "../src/domain/market-trading-model.js";

const MARKET: MarketAnalysisReport = {
  marketHashName: "M4A1-S | Nightmare (Factory New)",
  generatedAt: "2026-07-22T02:05:00.000+08:00",
  query: { platform: "STEAM", klineType: 1 },
  currentMarket: {
    quotes: [],
    lowestListing: { platform: "YYYP", price: 1900 },
    highestBid: { platform: "C5", price: 1910 },
    visibleDemandSupplyRatio: 0.1227,
  },
  trend: {
    label: "downtrend",
    pointCount: 2159,
    returnsPct: { hours24: 2.5808, days7: -14.5427, days14: -16.2867, days30: -27.718 },
    estimatedDailyVolatility7dPct: 8.4414,
  },
  relativeMarket: { available: false, unavailableReason: "not used by sector context" },
  dataQuality: {
    score: 84,
    confidence: "high",
    usablePricePlatforms: 5,
    totalPricePlatforms: 9,
    stalePricePlatforms: 0,
    unavailablePricePlatforms: 4,
    warnings: [],
  },
  evidence: [{ source: "steamdt", observedAt: "2026-07-22T02:05:00.000+08:00", confidence: "verified_source" }],
  narrativeZh: { conclusion: "downtrend", keyData: [], risks: [] },
};

test("market-trading model keeps sector, effective float, and expert annotations separate", () => {
  const report = assessMarketTrading({
    market: MARKET,
    holderStatus: "available",
    holders: {
      observedAccounts: 240,
      observedQuantity: 3788,
      top1Quantity: 167,
      top5Quantity: 728,
      top10Quantity: 1240,
      top1SharePct: 4.4087,
      top5SharePct: 19.2186,
      top10SharePct: 32.735,
      scope: "csqaq_monitored_accounts",
    },
    supplyStatus: "available",
    supply: { pointCount: 180, currentQuantity: 20456, change30dPct: 2.5004 },
    context: {
      sector: {
        name: "千战指数",
        returnPct: -8.11,
        windowDays: 15,
        provenance: { sourceType: "manual_provider_observation", label: "用户提供的 CSQAQ 板块截图" },
      },
      effectiveCirculatingSupply: {
        central: 12_000,
        low: 10_000,
        high: 14_000,
        provenance: { sourceType: "user_expert", label: "用户市场经验估算" },
      },
      dealerOperation: {
        suitability: "high",
        provenance: { sourceType: "user_expert", label: "用户市场经验标注" },
      },
      tradeUp: {
        role: "input",
        contractInputCount: 5,
        outputItems: [{ name: "Sport Gloves | Hedge Maze" }],
        provenance: { sourceType: "user_expert", label: "用户确认的汰换关系" },
      },
    },
  });

  assert.equal(report.model.type, "market_trading");
  assert.equal(report.phase, "risk_off");
  assert.equal(report.role, "dealer_operable");
  assert.equal(report.dimensions.sector.itemComparableWindowDays, 14);
  assert.equal(report.dimensions.sector.relativeStrengthPctPoints, -8.1767);
  assert.equal(report.dimensions.effectiveFloat.estimatedCirculatingRatioPct, 58.6625);
  assert.equal(report.dimensions.effectiveFloat.observedTop10ShareOfEstimatedFloatPct, 10.3333);
  assert.equal(report.dimensions.tradeUp.status, "relationship_only");
  assert.ok(report.expertAnnotations.some((value) => value.includes("用户市场经验估算")));
  assert.ok(report.verifiedObservations.every((value) => !value.includes("有效流通盘")));
});

test("market-trading model calculates trade-up economics only from a complete probability basket", () => {
  const report = assessMarketTrading({
    market: MARKET,
    holderStatus: "not_requested",
    supplyStatus: "not_requested",
    context: {
      tradeUp: {
        role: "input",
        contractInputCount: 5,
        inputUnitPrice: 100,
        otherCost: 0,
        outputItems: [
          { name: "Outcome A", probability: 0.5, referencePrice: 600 },
          { name: "Outcome B", probability: 0.5, referencePrice: 500 },
        ],
        provenance: { sourceType: "user_expert", label: "测试篮子" },
      },
    },
  });
  assert.equal(report.dimensions.tradeUp.status, "economics_available");
  assert.equal(report.dimensions.tradeUp.inputCost, 500);
  assert.equal(report.dimensions.tradeUp.weightedOutputValue, 550);
  assert.equal(report.dimensions.tradeUp.expectedMarginPct, 10);
});
