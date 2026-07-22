import assert from "node:assert/strict";
import test from "node:test";

import { SteamDtClient } from "../src/adapters/steamdt/client.js";
import { WechatNotifier } from "../src/adapters/notifications/wechat.js";
import { AlertService } from "../src/services/alert-service.js";
import { MarketCompatibilityService } from "../src/services/market-compatibility-service.js";
import { AppDatabase } from "../src/storage/database.js";

test("alert service is edge-triggered, persists history, and respects cooldown", async () => {
  let nowMs = new Date("2026-07-20T00:00:00.000Z").valueOf();
  const now = () => new Date(nowMs);
  const prices = [10, 10, 13, 10, 10];
  const steamDt = new SteamDtClient({
    apiKey: "test-key",
    now,
    fetchImpl: async () => Response.json({
      success: true,
      data: [{
        platform: "BUFF",
        sellPrice: prices.shift() ?? 10,
        sellCount: 100,
        updateTime: nowMs,
      }],
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
  const market = new MarketCompatibilityService(steamDt, undefined, database, now);
  const service = new AlertService(market, database, {
    notifier,
    now,
    notificationRetry: { delay: async () => undefined },
  });
  const rule = service.addMarketRule({
    marketHashName: "Synthetic Case",
    platform: "BUFF",
    provider: "steamdt",
    metric: "sell_price",
    operator: "lt",
    threshold: 12,
    cooldownMinutes: 60,
  });

  assert.equal((await service.runOnce()).results[0]?.status, "notified");
  assert.equal((await service.runOnce()).results[0]?.status, "duplicate_active_condition");
  assert.equal((await service.runOnce()).results[0]?.status, "not_matched");
  nowMs += 30 * 60_000;
  assert.equal((await service.runOnce()).results[0]?.status, "cooldown");
  nowMs += 31 * 60_000;
  assert.equal((await service.runOnce()).results[0]?.status, "notified");
  assert.equal(messages, 2);
  assert.equal(database.countRows("alert_rules"), 1);
  assert.equal(database.countRows("alert_evaluations"), 5);
  assert.equal(database.countRows("alert_deliveries"), 2);
  assert.equal(service.setRuleEnabled(rule.id, false), true);
  assert.equal(service.listRules()[0]?.enabled, false);
  database.close();
});
