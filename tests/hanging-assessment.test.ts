import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_FEE_TEMPLATE } from "../src/domain/fee-template.js";
import { assessHangingEntry, classifyHangingItem } from "../src/domain/hanging-assessment.js";
import { estimateSevenDayScenarios } from "../src/domain/seven-day-scenario.js";

test("seven-day scenarios and hanging ratios are deterministic and expose assumptions", () => {
  const start = Date.UTC(2026, 0, 1) / 1000;
  const points = Array.from({ length: 31 }, (_, index) => {
    const close = 100 + index;
    return { timestamp: start + index * 86_400, open: close, close, high: close, low: close, raw: [start + index * 86_400, close, close, close, close] as const };
  });
  const scenario = estimateSevenDayScenarios(points);
  assert.equal(scenario.status, "available");
  assert.equal(scenario.momentum7dPct, 5.6911);

  const result = assessHangingEntry({
    entry: {
      goodId: "1",
      marketHashName: "Synthetic Item",
      name: "Synthetic",
      buffSellPrice: 70,
      steamBidPrice: 130,
      turnoverNumber: 20,
    },
    sourcePlatform: "BUFF",
    steamExitMode: "highest_bid",
    fees: { source: "built_in_default", template: DEFAULT_FEE_TEMPLATE },
    sevenDayScenario: scenario,
  });
  assert.equal(result.current?.steamBalanceAfterFee, 112.97);
  assert.equal(result.model.type, "hanging_execution");
  assert.equal(result.itemPolicy.category, "other");
  assert.equal(result.current?.steamBalancePerCny, 1.6139);
  assert.equal(result.feeAssumptions.template.steamSaleNetRate, 0.869);
  assert.ok(result.limitations.some((text) => text.includes("不是同一种资产")));
});

test("hanging model defaults to cases and weapon skins while excluding stickers, knives, and gloves", () => {
  assert.equal(classifyHangingItem("Danger Zone Case").treatment, "preferred");
  assert.equal(classifyHangingItem("AK-47 | Slate (Factory New)").defaultCandidatePoolEligible, true);
  assert.equal(classifyHangingItem("Sticker | Synthetic").defaultCandidatePoolEligible, false);
  assert.equal(classifyHangingItem("★ Sport Gloves | Hedge Maze (Factory New)").category, "gloves");
  assert.equal(classifyHangingItem("★ Karambit | Doppler (Factory New)").category, "knife");
});

test("an explicitly requested excluded category remains analyzable but cannot be promoted to candidate", () => {
  const result = assessHangingEntry({
    entry: {
      goodId: "2",
      marketHashName: "Sticker | Synthetic",
      name: "Synthetic Sticker",
      buffSellPrice: 70,
      steamBidPrice: 130,
      turnoverNumber: 20,
    },
    sourcePlatform: "BUFF",
    steamExitMode: "highest_bid",
    fees: { source: "built_in_default", template: DEFAULT_FEE_TEMPLATE },
    sevenDayScenario: {
      status: "available",
      generatedFrom: "steamdt_kline",
      dailyPointCount: 30,
      scenarios: {
        defensive: { returnPct: 0, price: 130 },
        base: { returnPct: 0, price: 130 },
        optimistic: { returnPct: 0, price: 130 },
      },
      method: [],
      limitations: [],
    },
    explicitItemRequest: true,
  });
  assert.equal(result.status, "caution");
  assert.equal(result.itemPolicy.treatment, "excluded_default");
});

test("platform-balance route uses daily card cost and rejects abnormal domestic bids", () => {
  const base = {
    goodId: "3",
    marketHashName: "AK-47 | Synthetic (Field-Tested)",
    name: "Synthetic",
    buffSellPrice: 100,
    buffBidPrice: 95,
    steamSellPrice: 120,
    turnoverNumber: 30,
  };
  const result = assessHangingEntry({
    entry: base,
    targetBalance: "platform",
    sourcePlatform: "BUFF",
    steamPurchaseMode: "listing",
    platformExitMode: "highest_bid",
    cardPrice: { priceCnyPer100Usd: 503.6, recordedAt: "2026-07-22T00:00:00Z" },
    fees: { source: "built_in_default", template: DEFAULT_FEE_TEMPLATE },
  });
  assert.equal(result.targetBalance, "platform");
  assert.equal(result.current?.steamFaceValueUsd, 16.6667);
  assert.equal(result.current?.cardCostCny, 83.9333);
  assert.equal(result.current?.platformNetProceedsCny, 92.625);
  assert.equal(result.current?.returnPct, 10.3554);

  const abnormal = assessHangingEntry({
    entry: { ...base, buffBidPrice: 200 },
    targetBalance: "platform",
    sourcePlatform: "BUFF",
    cardPrice: { priceCnyPer100Usd: 503.6, recordedAt: "2026-07-22T00:00:00Z" },
    fees: { source: "built_in_default", template: DEFAULT_FEE_TEMPLATE },
  });
  assert.equal(abnormal.status, "insufficient_data");
  assert.equal(abnormal.dataQuality.valid, false);
});
