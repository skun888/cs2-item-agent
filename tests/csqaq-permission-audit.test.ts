import assert from "node:assert/strict";
import test from "node:test";

import { CsQaqClient } from "../src/adapters/csqaq/client.js";
import {
  auditCsQaqPersonalPermissions,
  CSQAQ_AUDIT_MINIMUM_INTERVAL_MS,
} from "../src/services/csqaq-permission-audit.js";

test("personal permission audit respects rate pacing and never retains response values", async () => {
  let requestCount = 0;
  const delays: number[] = [];
  const fakeFetch: typeof fetch = async () => {
    requestCount += 1;
    return Response.json({
      code: 200,
      msg: "Success",
      data: [{ steam_id: "76561190000000000", steam_name: "sensitive-name", value: 1 }],
    });
  };
  const fixedNow = () => new Date("2026-07-20T00:00:00.000Z");
  const client = new CsQaqClient({ apiToken: "test-token", fetchImpl: fakeFetch, now: fixedNow });

  const report = await auditCsQaqPersonalPermissions(client, {
    now: fixedNow,
    delay: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });

  assert.equal(requestCount, 8);
  assert.equal(delays.length, 7);
  assert.ok(delays.every((value) => value === CSQAQ_AUDIT_MINIMUM_INTERVAL_MS));
  assert.equal(report.summary.available, 8);
  assert.equal(report.summary.not_probed, 2);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("76561190000000000"), false);
  assert.equal(serialized.includes("sensitive-name"), false);
  assert.equal(serialized.includes("test-token"), false);
});
