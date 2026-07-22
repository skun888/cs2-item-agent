import assert from "node:assert/strict";
import test from "node:test";

import { summarizeHolderConcentration, summarizeSupplyTrend } from "../src/domain/provider-intelligence.js";

test("holder concentration is explicitly calculated inside the monitored sample", () => {
  const summary = summarizeHolderConcentration([
    { monitorId: "1", steamId: "76561190000000001", steamName: "A", quantity: 50 },
    { monitorId: "1-duplicate", steamId: "76561190000000001", steamName: "A", quantity: 50 },
    { monitorId: "2", steamId: "76561190000000002", steamName: "B", quantity: 30 },
    { monitorId: "3", steamId: "76561190000000003", steamName: "C", quantity: 20 },
  ]);
  assert.equal(summary.scope, "csqaq_monitored_accounts");
  assert.equal(summary.observedQuantity, 100);
  assert.equal(summary.top1SharePct, 50);
  assert.equal(summary.top5SharePct, 100);
});

test("supply summary reports changes only when a baseline exists", () => {
  const start = Date.UTC(2026, 0, 1);
  const points = Array.from({ length: 31 }, (_, index) => ({
    recordedAt: new Date(start + index * 86_400_000).toISOString(),
    quantity: 100 + index,
  }));
  const summary = summarizeSupplyTrend(points);
  assert.equal(summary.currentQuantity, 130);
  assert.equal(summary.change30dPct, 30);
  assert.equal(summary.change7dPct, 5.6911);
  assert.equal(summary.change90dPct, undefined);
});
