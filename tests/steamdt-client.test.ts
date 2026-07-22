import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../src/core/errors.js";
import { SteamDtClient } from "../src/adapters/steamdt/client.js";

test("SteamDT price response is normalized without leaking the key", async () => {
  let requestedUrl = "";
  let authorization = "";
  const fakeFetch: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get("Authorization") ?? "";
    return Response.json({
      success: true,
      data: [
        {
          platform: "SYNTHETIC_PLATFORM",
          platformItemId: 10001,
          sellPrice: "12.34",
          sellCount: 56,
          biddingPrice: 11.11,
          biddingCount: 78,
          updateTime: 1_700_000_000_000,
        },
      ],
    });
  };
  const client = new SteamDtClient({
    apiKey: "test-secret-never-log",
    fetchImpl: fakeFetch,
    now: () => new Date("2026-07-20T00:00:00.000Z"),
  });

  const result = await client.getSinglePrice("Danger Zone Case");

  assert.match(requestedUrl, /marketHashName=Danger\+Zone\+Case/);
  assert.equal(authorization, "Bearer test-secret-never-log");
  assert.equal(requestedUrl.includes("test-secret-never-log"), false);
  assert.equal(result.confidence, "verified_source");
  assert.equal(result.data[0]?.platformItemId, "10001");
  assert.equal(result.data[0]?.sellPrice, 12.34);
});

test("SteamDT provider errors retain a safe provider code", async () => {
  const fakeFetch: typeof fetch = async () =>
    Response.json({ success: false, errorCode: 42901, errorMessage: "rate limited" });
  const client = new SteamDtClient({ apiKey: "test-key", fetchImpl: fakeFetch });

  await assert.rejects(
    () => client.getSinglePrice("Synthetic Item"),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "PROVIDER_ERROR" &&
      error.details?.providerCode === 42901,
  );
});

test("SteamDT batch prices use the documented POST contract", async () => {
  let requestBody: unknown;
  let method = "";
  const client = new SteamDtClient({
    apiKey: "test-key",
    fetchImpl: async (_input, init) => {
      method = init?.method ?? "";
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        success: true,
        data: [{
          marketHashName: "Synthetic Case",
          dataList: [{ platform: "BUFF", sellPrice: 12.5, sellCount: 10, updateTime: 1_700_000_000 }],
        }],
      });
    },
  });
  const result = await client.getBatchPrices(["Synthetic Case"]);
  assert.equal(method, "POST");
  assert.deepEqual(requestBody, { marketHashNames: ["Synthetic Case"] });
  assert.equal(result.data[0]?.marketHashName, "Synthetic Case");
  assert.equal(result.data[0]?.dataList[0]?.sellPrice, 12.5);
});

test("SteamDT schema drift fails loudly", async () => {
  const fakeFetch: typeof fetch = async () =>
    Response.json({ success: true, data: [{ sellPrice: 10 }] });
  const client = new SteamDtClient({ apiKey: "test-key", fetchImpl: fakeFetch });

  await assert.rejects(
    () => client.getSinglePrice("Synthetic Item"),
    (error: unknown) => error instanceof AppError && error.code === "CONTRACT_ERROR",
  );
});

test("SteamDT K-line uses the documented POST JSON contract", async () => {
  let method = "";
  let contentType = "";
  let requestBody: unknown;
  const fakeFetch: typeof fetch = async (_input, init) => {
    method = init?.method ?? "";
    contentType = new Headers(init?.headers).get("Content-Type") ?? "";
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ success: true, data: [["1700000000", 10, 11, 12, 9]] });
  };
  const client = new SteamDtClient({ apiKey: "test-key", fetchImpl: fakeFetch });

  const result = await client.getKline({
    marketHashName: "Danger Zone Case",
    platform: "SYNTHETIC_PLATFORM",
    type: 1,
  });

  assert.equal(method, "POST");
  assert.equal(contentType, "application/json");
  assert.deepEqual(requestBody, {
    marketHashName: "Danger Zone Case",
    platform: "SYNTHETIC_PLATFORM",
    type: 1,
  });
  assert.deepEqual(result.data[0], {
    timestamp: 1_700_000_000,
    open: 10,
    close: 11,
    high: 12,
    low: 9,
    raw: ["1700000000", 10, 11, 12, 9],
  });
});

test("SteamDT inspect preview preserves rendered screenshot and sticker state", async () => {
  let requestBody: unknown;
  const client = new SteamDtClient({
    apiKey: "test-key",
    fetchImpl: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ success: true, data: {
        sync: true, success: true, taskId: "task-1",
        screenshot: { fingerprint: "fp", existSticker: true, protoEncodeStr: "0018", screenshots: {
          front: ["https://example.invalid/front.png"], back: [], detail: [],
        } },
      } });
    },
  });
  const result = await client.generateInspectPreview("steam://rungame/730/example");
  assert.deepEqual(requestBody, { inspectUrl: "steam://rungame/730/example" });
  assert.equal(result.data.existSticker, true);
  assert.equal(result.data.screenshots.front[0], "https://example.invalid/front.png");
});
