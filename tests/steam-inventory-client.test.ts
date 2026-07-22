import assert from "node:assert/strict";
import test from "node:test";

import { SteamInventoryClient } from "../src/adapters/steam-inventory/client.js";
import { AppError } from "../src/core/errors.js";

const STEAM_ID = "76561198000000000";

test("Steam public inventory client paginates and joins asset descriptions", async () => {
  const urls: string[] = [];
  const payloads = [
    inventoryPayload({
      assets: [{ assetid: "100", classid: "200", instanceid: "0", contextid: "2", amount: "1" }],
      descriptions: [description("200", "Synthetic Rifle")],
      assetProperties: [
        {
          assetid: "100",
          asset_properties: [
            { propertyid: 1, int_value: 321, name: "Pattern Template" },
            { propertyid: 2, float_value: 0.123456, name: "Wear Rating" },
            { propertyid: 7, int_value: 282, name: "Finish Catalog" },
          ],
        },
      ],
      moreItems: true,
      lastAssetId: "100",
      total: 2,
    }),
    inventoryPayload({
      assets: [{ assetid: "101", classid: "201", instanceid: "0", contextid: "2", amount: "2" }],
      descriptions: [description("201", "Synthetic Case")],
      moreItems: false,
      total: 2,
    }),
  ];
  const fetchFn = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return Response.json(payloads.shift());
  }) as typeof fetch;
  const client = new SteamInventoryClient({
    fetchFn,
    now: () => new Date("2026-07-20T00:00:00.000Z"),
  });

  const result = await client.getCs2Inventory(STEAM_ID);
  assert.equal(result.status, "public");
  assert.equal(result.complete, true);
  assert.equal(result.pageCount, 2);
  assert.equal(result.assets.length, 2);
  assert.equal(result.assets[1]?.amount, 2);
  assert.equal(result.assets[0]?.marketHashName, "Synthetic Rifle");
  assert.equal(result.assets[0]?.paintSeed, 321);
  assert.equal(result.assets[0]?.paintIndex, 282);
  assert.equal(result.assets[0]?.paintWear, 0.123456);
  assert.equal(typeof result.assets[0]?.paintWearBits, "number");
  assert.match(result.assets[0]?.observationFingerprint ?? "", /^cs2obs:v1:[a-f0-9]{64}$/);
  assert.equal(
    result.assets[0]?.inspectLink,
    `steam://rungame/730/0/+csgo_econ_action_preview%20S${STEAM_ID}A100D1`,
  );
  assert.match(urls[1] ?? "", /start_assetid=100/);
});

test("Steam public inventory client preserves private and rate-limited states", async () => {
  const privateClient = new SteamInventoryClient({
    fetchFn: (async () => new Response("private", { status: 403 })) as typeof fetch,
  });
  const privateResult = await privateClient.getCs2Inventory(STEAM_ID);
  assert.equal(privateResult.status, "private_or_unavailable");
  assert.equal(privateResult.complete, false);
  assert.deepEqual(privateResult.assets, []);

  const limitedClient = new SteamInventoryClient({
    fetchFn: (async () => new Response("limited", { status: 429 })) as typeof fetch,
  });
  const limitedResult = await limitedClient.getCs2Inventory(STEAM_ID);
  assert.equal(limitedResult.status, "rate_limited");
});

test("Steam public inventory client resolves new item-certificate inspect links", async () => {
  const certificate = "001807208B08280438004000";
  const client = new SteamInventoryClient({
    fetchFn: (async () => Response.json(inventoryPayload({
      assets: [{ assetid: "100", classid: "200", instanceid: "0", contextid: "2", amount: "1" }],
      descriptions: [{
        ...description("200", "Synthetic Rifle"),
        actions: [{
          name: "Inspect in Game...",
          link: "steam://rungame/730/0/+csgo_econ_action_preview%20%propid:6%",
        }],
      }],
      assetProperties: [{
        assetid: "100",
        asset_properties: [{ propertyid: 6, string_value: certificate, name: "Item Certificate" }],
      }],
      moreItems: false,
      total: 1,
    }))) as typeof fetch,
  });
  const result = await client.getCs2Inventory(STEAM_ID);
  assert.equal(result.assets[0]?.inspectLink, `steam://rungame/730/0/+csgo_econ_action_preview%20${certificate}`);
  assert.equal(result.assets[0]?.itemCertificate, certificate);
});

test("Steam public inventory client rejects non-SteamID64 input", async () => {
  const client = new SteamInventoryClient({ fetchFn: (async () => Response.json({})) as typeof fetch });
  await assert.rejects(
    () => client.getCs2Inventory("not-a-steamid"),
    (error: unknown) => error instanceof AppError && error.code === "USAGE_ERROR",
  );
});

function inventoryPayload(input: {
  readonly assets: readonly Readonly<Record<string, unknown>>[];
  readonly descriptions: readonly Readonly<Record<string, unknown>>[];
  readonly assetProperties?: readonly Readonly<Record<string, unknown>>[];
  readonly moreItems: boolean;
  readonly lastAssetId?: string;
  readonly total: number;
}): Readonly<Record<string, unknown>> {
  return {
    success: 1,
    assets: input.assets,
    descriptions: input.descriptions,
    ...(input.assetProperties ? { asset_properties: input.assetProperties } : {}),
    total_inventory_count: input.total,
    more_items: input.moreItems,
    ...(input.lastAssetId ? { last_assetid: input.lastAssetId } : {}),
  };
}

function description(classId: string, name: string): Readonly<Record<string, unknown>> {
  return {
    classid: classId,
    instanceid: "0",
    market_hash_name: name,
    market_name: name,
    tradable: 1,
    marketable: 1,
    actions: [
      {
        name: "Inspect in Game...",
        link: "steam://rungame/730/0/+csgo_econ_action_preview%20S%owner_steamid%A%assetid%D1",
      },
    ],
  };
}
