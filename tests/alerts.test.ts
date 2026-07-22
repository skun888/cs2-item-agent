import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateMarketAlertRule,
  isCooldownActive,
  type MarketAlertRule,
} from "../src/domain/alerts.js";

const RULE: MarketAlertRule = {
  id: 1,
  enabled: true,
  marketHashName: "Synthetic Case",
  platform: "BUFF",
  provider: "any",
  metric: "sell_price",
  operator: "lt",
  threshold: 12,
  cooldownMinutes: 60,
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
  lastConditionMet: false,
};

test("market alert selects the strongest matching provider quote and ignores zero placeholders", () => {
  const evaluation = evaluateMarketAlertRule(
    RULE,
    [
      {
        marketHashName: "Synthetic Case",
        platform: "BUFF",
        provider: "steamdt",
        source: "steamdt:price-single",
        observedAt: "2026-07-20T00:00:00.000Z",
        currency: "CNY",
        sellPrice: 11,
      },
      {
        marketHashName: "Synthetic Case",
        platform: "BUFF",
        provider: "csqaq",
        source: "csqaq:batch-prices",
        observedAt: "2026-07-20T00:01:00.000Z",
        currency: "CNY",
        sellPrice: 10,
      },
      {
        marketHashName: "Synthetic Case",
        platform: "BUFF",
        provider: "steamdt",
        source: "steamdt:price-single",
        observedAt: "2025-01-01T00:00:00.000Z",
        currency: "CNY",
        sellPrice: 0,
      },
    ],
    new Date("2026-07-20T00:02:00.000Z"),
  );

  assert.equal(evaluation.status, "matched");
  assert.equal(evaluation.value, 10);
  assert.equal(evaluation.provider, "csqaq");
  assert.equal(evaluation.evidenceFingerprint?.length, 64);
});

test("cooldown uses the last successful trigger time", () => {
  assert.equal(
    isCooldownActive(
      { ...RULE, lastTriggeredAt: "2026-07-20T00:30:00.000Z" },
      new Date("2026-07-20T01:00:00.000Z"),
    ),
    true,
  );
  assert.equal(
    isCooldownActive(
      { ...RULE, lastTriggeredAt: "2026-07-20T00:00:00.000Z" },
      new Date("2026-07-20T01:00:00.000Z"),
    ),
    false,
  );
});
