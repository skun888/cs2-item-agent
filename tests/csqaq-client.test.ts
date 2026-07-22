import assert from "node:assert/strict";
import test from "node:test";

import { CsQaqClient } from "../src/adapters/csqaq/client.js";

test("CSQAQ audit sends ApiToken header and emits only a structural summary", async () => {
  let requestedUrl = "";
  let tokenHeader = "";
  const fakeFetch: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    tokenHeader = new Headers(init?.headers).get("ApiToken") ?? "";
    return Response.json({
      code: 200,
      msg: "Success",
      data: {
        res: [{ steam_id: "76561190000000000", steam_name: "private-example", amount: 100 }],
        total: 1,
      },
    });
  };
  const client = new CsQaqClient({
    apiToken: "local-secret-never-log",
    fetchImpl: fakeFetch,
    now: () => new Date("2026-07-20T00:00:00.000Z"),
  });

  const result = await client.auditProbe({
    id: "monitor",
    label: "monitor",
    documentedTier: "unclear",
    method: "POST",
    path: "/api/v1/monitor/get_task_list",
    body: { page_index: 1, page_size: 1 },
  });

  assert.equal(tokenHeader, "local-secret-never-log");
  assert.equal(requestedUrl.includes("local-secret-never-log"), false);
  assert.equal(result.status, "available");
  assert.deepEqual(result.dataShape.fields, ["res", "res[].amount", "res[].steam_id", "res[].steam_name", "total"]);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("76561190000000000"), false);
  assert.equal(serialized.includes("private-example"), false);
  assert.equal(serialized.includes("local-secret-never-log"), false);
});

test("CSQAQ audit distinguishes permission denial from IP binding requirements", async () => {
  const responses = [
    Response.json({ code: 403, msg: "企业接口无权限" }),
    Response.json({ code: 400, msg: "请先绑定IP白名单" }),
  ];
  const client = new CsQaqClient({
    apiToken: "test-token",
    fetchImpl: async () => responses.shift() ?? Response.json({ code: 500, msg: "missing" }),
  });
  const spec = {
    id: "test",
    label: "test",
    documentedTier: "unclear" as const,
    method: "POST" as const,
    path: "/test",
  };

  assert.equal((await client.auditProbe(spec)).status, "permission_denied");
  assert.equal((await client.auditProbe(spec)).status, "configuration_required");
});

test("CSQAQ personal intelligence methods normalize documented contracts", async () => {
  const requests: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("get_good_id")) {
      return Response.json({ code: 200, data: { data: { "42": { id: 42, name: "测试饰品", market_hash_name: "Synthetic Item" } } } });
    }
    if (url.includes("good/statistic")) {
      return Response.json({ code: 200, data: [{ statistic: 123, created_at: "2026-01-01T00:00:00" }] });
    }
    if (url.includes("monitor/rank")) {
      return Response.json({ code: 200, data: [{ id: 1, steam_name: "Holder", steam_id: "76561190000000000", num: 7 }] });
    }
    return Response.json({ code: 404, msg: "missing" }, { status: 404 });
  };
  const client = new CsQaqClient({
    apiToken: "test-token",
    fetchImpl: fakeFetch,
    minimumRequestIntervalMs: 0,
    now: () => new Date("2026-07-21T00:00:00.000Z"),
  });

  assert.equal((await client.searchItemIdentities("Synthetic Item")).data[0]?.goodId, "42");
  assert.equal((await client.getHolderRanking("42")).data[0]?.quantity, 7);
  assert.equal((await client.getSupplyTrend("42")).data[0]?.quantity, 123);
  assert.ok(requests[2]?.includes("id=42"));
});

test("CSQAQ DIY catalog page and detail preserve provider facts", async () => {
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("get_good_id")) {
      return Response.json({ code: 200, data: {
        data: { "42": { id: 42, name: "AK-47 | 墨岩（崭新出厂）", market_hash_name: "AK-47 | Slate (Factory New)" } },
        page_index: 2, page_size: 25, total: 51,
      } });
    }
    return Response.json({ code: 200, data: { goods_info: {
      id: 42, name: "AK-47 | 墨岩（崭新出厂）", market_hash_name: "AK-47 | Slate (Factory New)",
      img: "https://example.invalid/slate.png", type_localized_name: "步枪", rarity_localized_name: "受限",
      exterior_localized_name: "崭新出厂", def_index: 7, paint_index: 1035, min_float: 0, max_float: 1,
      buff_sell_price: 19.9, updated_at: "2026-07-21T00:00:00Z",
    } } });
  };
  const client = new CsQaqClient({ apiToken: "test-token", fetchImpl: fakeFetch, minimumRequestIntervalMs: 0 });
  const page = await client.searchItemIdentityPage("墨岩", 2, 25);
  assert.equal(page.data.total, 51);
  assert.equal(page.data.items[0]?.marketHashName, "AK-47 | Slate (Factory New)");
  const detail = await client.getItemDetail("42");
  assert.equal(detail.data.paintIndex, 1035);
  assert.equal(detail.data.buffSellPrice, 19.9);
});

test("CSQAQ sector, card price, K-line, and collection contracts are normalized", async () => {
  const requests: string[] = [];
  const client = new CsQaqClient({
    apiToken: "secret",
    minimumRequestIntervalMs: 0,
    now: () => new Date("2026-07-22T08:00:00Z"),
    fetchImpl: async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("current_data")) return Response.json({ code: 200, msg: "Success", data: {
        sub_index_data: [{ id: 16, name: "千战指数", name_key: "thousand_weapon", market_index: 245226.11, chg_num: -21635, chg_rate: -8.11, open: 266861, close: 245226.11, high: 267000, low: 245000, updated_at: "2026-07-22T07:00:00Z" }],
        card_price: [{ price: 503.6, created_at: "2026-07-22T00:00:00Z" }],
      }});
      if (url.includes("sub/kline")) return Response.json({ code: 200, msg: "Success", data: [{ t: "1784592000000", o: 100, c: 98, h: 101, l: 97, v: 12 }] });
      if (url.includes("container_data_info")) return Response.json({ code: 200, msg: "Success", data: [{ id: 275, name: "2018 核子危机收藏品", comment: "collection", created_at: "2018-09-01T00:00:00Z" }] });
      return Response.json({ code: 200, msg: "Success", data: [{ id: 9618, short_name: "Glock-18 | 核子花园", rln: "受限", qln: "普通", price: 100 }] });
    },
  });
  const home = await client.getMarketHomeData();
  assert.equal(home.data.sectors[0]?.nameKey, "thousand_weapon");
  assert.equal(home.data.cardPrices[0]?.priceCnyPer100Usd, 503.6);
  assert.equal((await client.getSectorKline("16")).data[0]?.close, 98);
  assert.equal((await client.getCollections()).data[0]?.id, "275");
  assert.equal((await client.getCollectionItems("275")).data[0]?.rarityName, "受限");
  assert.ok(requests.some((url) => url.includes("type=1day")));
});
