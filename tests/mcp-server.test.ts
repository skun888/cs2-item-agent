import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { AppError } from "../src/core/errors.js";
import { createMcpConfigurationGuide } from "../src/mcp/configuration-guide.js";
import { createMcpServer } from "../src/mcp/create-server.js";
import { DEFAULT_FEE_TEMPLATE } from "../src/domain/fee-template.js";

test("MCP server lists the complete tools and answers health over the protocol", async () => {
  const server = createMcpServer({
    health: () => ({ ok: true, steamDt: { configured: false } }),
    getMarketService: () => {
      throw new AppError("CONFIG_ERROR", "not configured in protocol test");
    },
    getMarketCompatibilityService: () => {
      throw new AppError("CONFIG_ERROR", "multi-source providers not configured in protocol test");
    },
    getAlertService: () => {
      throw new AppError("CONFIG_ERROR", "alerts not configured in protocol test");
    },
    getInventoryService: () => {
      throw new AppError("CONFIG_ERROR", "inventory not configured in protocol test");
    },
    getCsQaqIntelligenceService: () => {
      throw new AppError("CONFIG_ERROR", "CSQAQ not configured in protocol test");
    },
    getHangingService: () => {
      throw new AppError("CONFIG_ERROR", "hanging not configured in protocol test");
    },
    getDecisionAnalysisService: () => {
      throw new AppError("CONFIG_ERROR", "decision analysis not configured in protocol test");
    },
    getSectorService: () => {
      throw new AppError("CONFIG_ERROR", "sector service not configured in protocol test");
    },
    getTradeUpCatalogService: () => {
      throw new AppError("CONFIG_ERROR", "trade-up catalog not configured in protocol test");
    },
    getDiyService: () => {
      throw new AppError("CONFIG_ERROR", "DIY not configured in protocol test");
    },
    getFeeAssumptions: () => ({ source: "built_in_default", template: DEFAULT_FEE_TEMPLATE }),
  });
  const client = new Client({ name: "cs2-item-agent-test", version: "0.8.0-alpha.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        "add_composite_alert_rule",
        "add_inventory_watch",
        "add_market_alert",
        "analyze_item_decision",
        "analyze_market_item",
        "analyze_market_trading",
        "analyze_tradeup_relationship",
        "assess_hanging_candidate",
        "check_public_inventory",
        "compare_market_prices",
        "disable_inventory_watch",
        "enrich_diy_catalog",
        "get_case_market_overview",
        "get_csqaq_holder_ranking",
        "get_csqaq_supply_trend",
        "get_diy_preferences",
        "get_market_kline",
        "get_market_prices",
        "get_sector_kline",
        "health_check",
        "list_alert_rules",
        "list_composite_alert_rules",
        "list_inventory_watches",
        "list_market_sectors",
        "preview_composite_alert_rule",
        "query_latest_inventory",
        "query_latest_inventory_valuation",
        "rank_local_inventory_holders",
        "recommend_diy_loadouts",
        "record_diy_feedback",
        "render_diy_preview",
        "resolve_csqaq_item",
        "run_alert_rules_once",
        "run_inventory_watches_once",
        "screen_hanging_candidates",
        "search_diy_catalog",
        "set_alert_rule_enabled",
        "set_composite_alert_rule_enabled",
        "show_hanging_fee_assumptions",
        "sync_diy_catalog",
        "sync_tradeup_catalog",
        "test_enterprise_wechat",
      ],
    );

    const health = await client.callTool({ name: "health_check", arguments: {} });
    assert.equal(health.isError, undefined);
    assert.deepEqual(
      {
        ok: (health.structuredContent as { ok: boolean }).ok,
        steamDt: (health.structuredContent as { steamDt: unknown }).steamDt,
      },
      {
        ok: true,
        steamDt: { configured: false },
      },
    );
    const usageGuide = (health.structuredContent as {
      usageGuide: {
        language: string;
        capabilityGroups: readonly { name: string; description: string }[];
        safeExamplePrompts: readonly { prompt: string; route: string }[];
        sideEffects: { trading: string };
        configurationReminder: string;
      };
    }).usageGuide;
    assert.equal(usageGuide.language, "zh-CN");
    assert.equal(usageGuide.capabilityGroups.length, 6);
    assert.equal(usageGuide.safeExamplePrompts.length, 5);
    assert.equal(usageGuide.safeExamplePrompts[0]?.route, "compare_market_prices");
    assert.match(usageGuide.sideEffects.trading, /不提供下单/);
    assert.match(usageGuide.configurationReminder, /本地 \.env/);
    const configurationGuide = (health.structuredContent as {
      configurationGuide: {
        restartRequiredAfterChange: boolean;
        summary: { configuredMarketProviderCount: number };
        entries: readonly { variable: string; status: string }[];
        nextActions: readonly string[];
      };
    }).configurationGuide;
    assert.equal(configurationGuide.restartRequiredAfterChange, true);
    assert.equal(configurationGuide.summary.configuredMarketProviderCount, 0);
    assert.deepEqual(
      configurationGuide.entries.map(({ variable, status }) => ({ variable, status })),
      [
        { variable: "STEAMDT_API_KEY", status: "not_configured" },
        { variable: "CSQAQ_API_TOKEN", status: "not_configured" },
        { variable: "STEAM_PROXY_URL", status: "not_configured" },
        { variable: "WECHAT_WEBHOOK_URL", status: "not_configured" },
      ],
    );
    assert.match(configurationGuide.nextActions.at(-1) ?? "", /不要把密钥粘贴到对话中/);

    const fees = await client.callTool({ name: "show_hanging_fee_assumptions", arguments: {} });
    assert.equal(fees.isError, undefined);
    assert.equal(
      (fees.structuredContent as { feeAssumptions: { template: { steamSaleNetRate: number } } })
        .feeAssumptions.template.steamSaleNetRate,
      0.869,
    );

    const error = await client.callTool({
      name: "get_market_prices",
      arguments: { marketHashName: "Synthetic Item" },
    });
    assert.equal(error.isError, true);
    assert.deepEqual(error.structuredContent, {
      ok: false,
      error: {
        code: "CONFIG_ERROR",
        message: "not configured in protocol test",
      },
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP configuration guide reports booleans without copying secret values", () => {
  const guide = createMcpConfigurationGuide({
    steamDt: { configured: true, accidentalSecret: "steamdt-do-not-copy" },
    csqaq: { configured: true, accidentalSecret: "csqaq-do-not-copy" },
    steamProxy: { configured: true, accidentalSecret: "proxy-do-not-copy" },
    wechat: { configured: true, accidentalSecret: "wechat-do-not-copy" },
  });

  assert.equal(guide.summary.configuredMarketProviderCount, 2);
  assert.equal(guide.summary.fullDataSourceExperienceConfigured, true);
  assert.ok(guide.entries.every((entry) => entry.status === "configured_unverified"));
  assert.doesNotMatch(JSON.stringify(guide), /do-not-copy/);
  assert.match(guide.nextActions.at(-1) ?? "", /不会自动发送测试消息/);
});
