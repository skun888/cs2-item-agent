import assert from "node:assert/strict";
import test from "node:test";

import { SteamInventoryClient } from "../src/adapters/steam-inventory/client.js";
import { InventoryMonitorService } from "../src/services/inventory-monitor-service.js";
import { AppDatabase } from "../src/storage/database.js";

const STEAM_ID = "76561198000000000";

test("inventory monitor creates a baseline, diffs complete snapshots, and ignores failed checks", async () => {
  const responses = [
    Response.json(payload([
      asset("100", "200", "Synthetic Rifle", "1"),
      asset("101", "201", "Synthetic Case", "2"),
    ])),
    Response.json(payload([
      asset("101", "201", "Synthetic Case", "3"),
      asset("102", "202", "Synthetic Knife", "1"),
    ])),
    new Response("private", { status: 403 }),
  ];
  const times = [
    new Date("2026-07-20T00:00:00.000Z"),
    new Date("2026-07-20T00:30:00.000Z"),
    new Date("2026-07-20T01:00:00.000Z"),
  ];
  const client = new SteamInventoryClient({
    fetchFn: (async () => responses.shift() ?? new Response("missing", { status: 500 })) as typeof fetch,
    now: () => times.shift() ?? new Date("2026-07-20T02:00:00.000Z"),
  });
  const database = new AppDatabase(":memory:");
  const service = new InventoryMonitorService(client, database);

  const baseline = await service.check(STEAM_ID);
  assert.equal(baseline.status, "public");
  assert.equal(baseline.baselineCreated, true);
  assert.equal(baseline.changes.events.length, 0);

  const changed = await service.check(STEAM_ID);
  assert.equal(changed.baselineCreated, false);
  assert.equal(changed.changes.added, 1);
  assert.equal(changed.changes.removed, 1);
  assert.equal(changed.changes.quantityChanged, 1);
  assert.deepEqual(
    changed.changes.categoryChanges.map((entry) => [entry.marketHashName, entry.delta]).sort(),
    [["Synthetic Case", 1], ["Synthetic Knife", 1], ["Synthetic Rifle", -1]].sort(),
  );

  const unavailable = await service.check(STEAM_ID);
  assert.equal(unavailable.status, "private_or_unavailable");
  assert.equal(unavailable.changes.events.length, 0);
  assert.equal(database.countRows("inventory_snapshots"), 2);
  assert.equal(database.countRows("inventory_checks"), 3);
  assert.equal(database.countRows("inventory_events"), 3);
  const latest = service.queryLatestInventory({ steamId: STEAM_ID, marketHashName: "Synthetic Case" });
  assert.equal(latest.status, "available");
  assert.equal(latest.totalMatchingAssets, 1);
  assert.equal(latest.assets[0]?.amount, 3);
  const ranking = service.rankHolders({ marketHashName: "Synthetic Case" });
  assert.equal(ranking.coverage.latestSuccessfulSnapshots, 1);
  assert.equal(ranking.holders[0]?.quantity, 3);
  assert.match(ranking.limitations[0] ?? "", /不是全网/);
  database.close();
});

test("inventory watches default to 30 minutes and disable without deleting history", () => {
  const database = new AppDatabase(":memory:");
  const service = new InventoryMonitorService(
    new SteamInventoryClient({ fetchFn: (async () => new Response("unused")) as typeof fetch }),
    database,
    { now: () => new Date("2026-07-20T00:00:00.000Z") },
  );
  const watch = service.addWatch({ steamId: STEAM_ID, label: "Synthetic Watch" });
  assert.equal(watch.intervalMinutes, 30);
  assert.equal(watch.enabled, true);
  assert.equal(service.listWatches().length, 1);
  assert.equal(service.disableWatch(STEAM_ID), true);
  assert.equal(service.listWatches()[0]?.enabled, false);
  assert.equal(database.countRows("inventory_watches"), 1);
  database.close();
});

function payload(
  entries: readonly { readonly asset: Readonly<Record<string, unknown>>; readonly description: Readonly<Record<string, unknown>> }[],
): Readonly<Record<string, unknown>> {
  return {
    success: 1,
    assets: entries.map((entry) => entry.asset),
    descriptions: entries.map((entry) => entry.description),
    total_inventory_count: entries.length,
    more_items: false,
  };
}

function asset(
  assetId: string,
  classId: string,
  name: string,
  amount: string,
): { readonly asset: Readonly<Record<string, unknown>>; readonly description: Readonly<Record<string, unknown>> } {
  return {
    asset: { assetid: assetId, classid: classId, instanceid: "0", contextid: "2", amount },
    description: { classid: classId, instanceid: "0", market_hash_name: name, market_name: name },
  };
}
