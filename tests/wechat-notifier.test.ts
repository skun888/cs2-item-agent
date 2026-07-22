import assert from "node:assert/strict";
import test from "node:test";

import { WechatNotifier } from "../src/adapters/notifications/wechat.js";
import { AppError } from "../src/core/errors.js";

test("Enterprise WeChat notifier sends a text payload without exposing the webhook", async () => {
  let body: unknown;
  const notifier = new WechatNotifier({
    webhookUrl: "https://example.invalid/cgi-bin/webhook/send?key=synthetic",
    fetchFn: (async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ errcode: 0, errmsg: "ok" });
    }) as typeof fetch,
  });
  const result = await notifier.sendText("Synthetic inventory change");
  assert.equal(result.status, "sent");
  assert.equal(result.attemptCount, 1);
  assert.deepEqual(body, {
    msgtype: "text",
    text: { content: "Synthetic inventory change" },
  });
});

test("Enterprise WeChat notifier retries transient failures", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const notifier = new WechatNotifier({
    webhookUrl: "https://example.invalid/cgi-bin/webhook/send?key=synthetic",
    fetchFn: (async () => {
      attempts += 1;
      return attempts < 3
        ? Response.json({ errcode: 93000, errmsg: "temporary" })
        : Response.json({ errcode: 0, errmsg: "ok" });
    }) as typeof fetch,
  });

  const result = await notifier.sendTextWithRetry("Synthetic retry", {
    maxAttempts: 3,
    baseDelayMs: 10,
    delay: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });

  assert.equal(result.attemptCount, 3);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
});

test("Enterprise WeChat notifier reports provider rejection safely", async () => {
  const notifier = new WechatNotifier({
    webhookUrl: "https://example.invalid/cgi-bin/webhook/send?key=synthetic",
    fetchFn: (async () => Response.json({ errcode: 93000, errmsg: "invalid webhook" })) as typeof fetch,
  });
  await assert.rejects(
    () => notifier.sendText("Synthetic inventory change"),
    (error: unknown) => error instanceof AppError && error.code === "NOTIFICATION_ERROR",
  );
});
