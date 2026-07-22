import assert from "node:assert/strict";
import test from "node:test";

import { WechatNotifier } from "../src/adapters/notifications/wechat.js";
import { SteamDtClient } from "../src/adapters/steamdt/client.js";
import {
  evaluateCompositeAlertExpression,
  previewCompositeAlertRule,
  type CompositeAlertLeaf,
} from "../src/domain/composite-alerts.js";
import { AlertService } from "../src/services/alert-service.js";
import { MarketCompatibilityService } from "../src/services/market-compatibility-service.js";
import { AppDatabase } from "../src/storage/database.js";

const STEAM_ID = "76561198000000000";

test("composite preview normalizes defaults and detects local-baseline requirements", () => {
  const preview = previewCompositeAlertRule({
    name: "低价并缩量",
    expression: {
      type: "all",
      conditions: [
        {
          type: "market",
          marketHashName: "Synthetic Case",
          platform: "buff",
          metric: "sell_price",
          operator: "lt",
          threshold: 10,
        },
        {
          type: "market",
          marketHashName: "Synthetic Case",
          platform: "BUFF",
          metric: "sell_count",
          mode: "change_rate",
          windowMinutes: 1_440,
          operator: "lte",
          threshold: -0.2,
        },
      ],
    },
  });
  assert.equal(preview.conditionCount, 2);
  assert.equal(preview.normalized.cooldownMinutes, 60);
  assert.equal(preview.normalized.maxDataSkewMinutes, 30);
  assert.equal(preview.requiresLocalBaseline, true);
  assert.deepEqual(preview.marketItems, ["Synthetic Case"]);
});

test("composite boolean evaluation preserves unknown and rejects excessive evidence skew", async () => {
  const first: CompositeAlertLeaf = {
    type: "market",
    marketHashName: "A",
    platform: "BUFF",
    metric: "sell_price",
    operator: "lt",
    threshold: 10,
  };
  const second: CompositeAlertLeaf = { ...first, marketHashName: "B" };
  const unknown = await evaluateCompositeAlertExpression(
    { type: "all", conditions: [first, second] },
    async (leaf) => leaf === first
      ? { condition: leaf, status: "matched", value: 9, observedAt: "2026-07-22T00:00:00.000Z", limitation: "test" }
      : { condition: leaf, status: "unknown", limitation: "missing" },
    new Date("2026-07-22T00:00:00.000Z"),
    30,
  );
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.conditionMet, undefined);

  const skewed = await evaluateCompositeAlertExpression(
    { type: "all", conditions: [first, second] },
    async (leaf) => ({
      condition: leaf,
      status: "matched",
      value: 9,
      observedAt: leaf === first ? "2026-07-22T00:00:00.000Z" : "2026-07-22T00:31:00.000Z",
      limitation: "test",
    }),
    new Date("2026-07-22T00:31:00.000Z"),
    30,
  );
  assert.equal(skewed.status, "unknown");
  assert.ok((skewed.dataSkewMinutes ?? 0) > 30);
});

test("market composite rules support consecutive matches and edge-triggered notification", async () => {
  let nowMs = new Date("2026-07-22T00:00:00.000Z").valueOf();
  const now = () => new Date(nowMs);
  const observations = [
    { sellPrice: 10, sellCount: 100 },
    { sellPrice: 10, sellCount: 100 },
    { sellPrice: 10, sellCount: 100 },
    { sellPrice: 13, sellCount: 100 },
  ];
  const steamDt = new SteamDtClient({
    apiKey: "test-key",
    now,
    fetchImpl: async () => Response.json({
      success: true,
      data: [{ platform: "BUFF", ...(observations.shift() ?? { sellPrice: 13, sellCount: 100 }), updateTime: nowMs }],
    }),
  });
  let messages = 0;
  const notifier = new WechatNotifier({
    webhookUrl: "https://example.invalid/webhook",
    fetchFn: (async () => {
      messages += 1;
      return Response.json({ errcode: 0, errmsg: "ok" });
    }) as typeof fetch,
  });
  const database = new AppDatabase(":memory:");
  const service = new AlertService(
    new MarketCompatibilityService(steamDt, undefined, database, now),
    database,
    { notifier, now, notificationRetry: { delay: async () => undefined } },
  );
  service.addCompositeRule({
    name: "连续低价且有库存",
    minimumConsecutiveMatches: 2,
    expression: {
      type: "all",
      conditions: [
        { type: "market", marketHashName: "Synthetic Case", platform: "BUFF", provider: "steamdt", metric: "sell_price", operator: "lt", threshold: 12 },
        { type: "market", marketHashName: "Synthetic Case", platform: "BUFF", provider: "steamdt", metric: "sell_count", operator: "gt", threshold: 50 },
      ],
    },
  });

  assert.equal((await service.runOnce()).compositeResults[0]?.status, "waiting_consecutive");
  nowMs += 30 * 60_000;
  assert.equal((await service.runOnce()).compositeResults[0]?.status, "notified");
  nowMs += 30 * 60_000;
  assert.equal((await service.runOnce()).compositeResults[0]?.status, "duplicate_active_condition");
  nowMs += 30 * 60_000;
  assert.equal((await service.runOnce()).compositeResults[0]?.status, "not_matched");
  assert.equal(messages, 1);
  assert.equal(database.countRows("composite_alert_rules"), 1);
  assert.equal(database.countRows("composite_alert_evaluations"), 4);
  assert.equal(database.countRows("composite_alert_deliveries"), 1);
  database.close();
});

test("inventory-only composite rules evaluate recent complete snapshot events without a market API", async () => {
  const now = () => new Date("2026-07-22T00:30:00.000Z");
  const database = new AppDatabase(":memory:");
  database.saveInventoryFetchResult(inventoryResult("2026-07-22T00:00:00.000Z", [inventoryAsset("1")]));
  database.saveInventoryFetchResult(inventoryResult("2026-07-22T00:30:00.000Z", [inventoryAsset("1"), inventoryAsset("2")]));
  let messages = 0;
  const notifier = new WechatNotifier({
    webhookUrl: "https://example.invalid/webhook",
    fetchFn: (async () => {
      messages += 1;
      return Response.json({ errcode: 0, errmsg: "ok" });
    }) as typeof fetch,
  });
  const service = new AlertService(undefined, database, { notifier, now });
  service.addCompositeRule({
    name: "公开库存新增",
    expression: {
      type: "inventory",
      steamId: STEAM_ID,
      metric: "added_quantity",
      windowMinutes: 30,
      operator: "gte",
      threshold: 1,
    },
  });
  const result = await service.runOnce();
  assert.equal(result.compositeResults[0]?.status, "notified");
  assert.equal(result.compositeResults[0]?.evaluation.leaves[0]?.value, 1);
  assert.equal(messages, 1);
  database.close();
});

test("market change-rate conditions use a same-provider local baseline at the provider-time window", async () => {
  const now = () => new Date("2026-07-22T00:05:00.000Z");
  const database = new AppDatabase(":memory:");
  database.saveNormalizedMarketQuotes([{
    marketHashName: "Synthetic Case",
    platform: "BUFF",
    provider: "steamdt",
    source: "steamdt:price-single",
    observedAt: "2026-07-21T00:00:00.000Z",
    currency: "CNY",
    sellPrice: 10,
    sellCount: 100,
  }]);
  const steamDt = new SteamDtClient({
    apiKey: "test-key",
    now,
    fetchImpl: async () => Response.json({
      success: true,
      data: [{ platform: "BUFF", sellPrice: 10, sellCount: 70, updateTime: new Date("2026-07-22T00:00:00.000Z").valueOf() }],
    }),
  });
  let messages = 0;
  const notifier = new WechatNotifier({
    webhookUrl: "https://example.invalid/webhook",
    fetchFn: (async () => {
      messages += 1;
      return Response.json({ errcode: 0, errmsg: "ok" });
    }) as typeof fetch,
  });
  const service = new AlertService(
    new MarketCompatibilityService(steamDt, undefined, database, now),
    database,
    { notifier, now },
  );
  service.addCompositeRule({
    name: "24小时在售量下降",
    expression: {
      type: "market",
      marketHashName: "Synthetic Case",
      platform: "BUFF",
      provider: "steamdt",
      metric: "sell_count",
      mode: "change_rate",
      windowMinutes: 1_440,
      operator: "lte",
      threshold: -0.2,
    },
  });
  const result = await service.runOnce();
  const leaf = result.compositeResults[0]?.evaluation.leaves[0];
  assert.equal(result.compositeResults[0]?.status, "notified");
  assert.equal(leaf?.baselineValue, 100);
  assert.equal(leaf?.value, -0.3);
  assert.equal(messages, 1);
  database.close();
});

function inventoryResult(observedAt: string, assets: ReturnType<typeof inventoryAsset>[]) {
  return {
    source: "steam-community:public-inventory" as const,
    steamId: STEAM_ID,
    observedAt,
    status: "public" as const,
    assets,
    totalInventoryCount: assets.length,
    pageCount: 1,
    complete: true,
  };
}

function inventoryAsset(assetId: string) {
  return {
    assetId,
    classId: assetId,
    instanceId: "0",
    contextId: "2",
    amount: 1,
    marketHashName: "Synthetic Case",
    raw: {},
  };
}
