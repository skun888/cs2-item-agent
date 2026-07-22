import assert from "node:assert/strict";
import test from "node:test";

import type { MarketAnalysisReport } from "../src/domain/market-analysis.js";
import { DecisionAnalysisService } from "../src/services/decision-analysis-service.js";

const MARKET_REPORT: MarketAnalysisReport = {
  marketHashName: "Synthetic Item",
  generatedAt: "2026-07-21T00:00:00.000Z",
  query: { platform: "STEAM", klineType: 1 },
  currentMarket: {
    quotes: [],
    lowestListing: { platform: "BUFF", price: 100 },
    highestBid: { platform: "STEAM", price: 150 },
    visibleDemandSupplyRatio: 1.2,
  },
  trend: {
    label: "uptrend",
    pointCount: 90,
    returnsPct: { days7: 5 },
    estimatedDailyVolatility7dPct: 3,
  },
  relativeMarket: {
    available: true,
    itemReturn7dPct: 5,
    broadReturn7dPct: 2,
    relativeStrength7dPctPoints: 3,
  },
  dataQuality: {
    score: 90,
    confidence: "high",
    usablePricePlatforms: 3,
    totalPricePlatforms: 3,
    stalePricePlatforms: 0,
    unavailablePricePlatforms: 0,
    warnings: [],
  },
  evidence: [{ source: "synthetic", observedAt: "2026-07-21T00:00:00.000Z", confidence: "verified_source" }],
  narrativeZh: { conclusion: "synthetic", keyData: [], risks: [] },
};

test("comprehensive decision report separates verified facts, coverage, risks, and prohibited claims", async () => {
  const service = new DecisionAnalysisService(
    { analyze: async () => MARKET_REPORT },
    {
      analyzeHolders: async () => ({
        item: { goodId: "1", name: "合成饰品", marketHashName: "Synthetic Item" },
        coverage: {
          scope: "csqaq_monitored_accounts",
          statementZh: "sample only",
          rawRows: 10,
          deduplicatedAccounts: 10,
          deduplication: "by SteamID",
        },
        concentration: {
          observedAccounts: 10,
          observedQuantity: 100,
          top1Quantity: 20,
          top5Quantity: 60,
          top10Quantity: 100,
          top1SharePct: 20,
          top5SharePct: 60,
          top10SharePct: 100,
          scope: "csqaq_monitored_accounts",
        },
        ranking: [],
        evidence: { source: "csqaq:holders", observedAt: "2026-07-21T00:00:00.000Z", confidence: "verified_source", limitations: [] },
      }),
      analyzeSupply: async () => ({
        item: { goodId: "1", name: "合成饰品", marketHashName: "Synthetic Item" },
        summary: { pointCount: 180, currentQuantity: 1000, change30dPct: 2 },
        points: [],
        evidence: { source: "csqaq:supply", observedAt: "2026-07-21T00:00:00.000Z", confidence: "verified_source", limitations: [] },
      }),
    },
    () => new Date("2026-07-21T00:00:00.000Z"),
  );
  const report = await service.analyze({ marketHashName: "Synthetic Item" });
  assert.equal(report.holderCoverage.status, "available");
  assert.equal(report.model.type, "market_trading");
  assert.equal(report.marketTrading.model.type, "market_trading");
  assert.equal(report.supplyTrend.status, "available");
  assert.ok(report.decisionFrame.verifiedFacts.some((fact) => fact.includes("Top 10")));
  assert.ok(report.decisionFrame.riskSignals.some((risk) => risk.includes("高度集中")));
  assert.ok(report.decisionFrame.prohibitedClaims.some((claim) => claim.includes("全网")));
});

test("decision report degrades optional provider failures instead of inventing values", async () => {
  const service = new DecisionAnalysisService(
    { analyze: async () => MARKET_REPORT },
    {
      analyzeHolders: async () => { throw new Error("failure"); },
      analyzeSupply: async () => { throw new Error("failure"); },
    },
  );
  const report = await service.analyze({ marketHashName: "Synthetic Item" });
  assert.equal(report.holderCoverage.status, "unavailable");
  assert.equal(report.supplyTrend.status, "unavailable");
  assert.equal(report.decisionFrame.confidence, "low");
  assert.ok(report.decisionFrame.unknowns.some((value) => value.includes("不可用")));
});
