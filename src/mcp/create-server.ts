import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { KlineQuery, SteamDtPriceEntry } from "../adapters/steamdt/types.js";
import { toPublicError } from "../core/errors.js";
import { summarizeKline } from "../domain/kline-summary.js";
import type { MarketAnalysisReport } from "../domain/market-analysis.js";
import type { Evidence } from "../domain/evidence.js";
import type { AnalyzeMarketRequest } from "../services/market-service.js";
import type { MultiSourcePriceReport } from "../services/market-compatibility-service.js";
import type { AlertRunReport } from "../services/alert-service.js";
import type { CreateMarketAlertRuleInput, MarketAlertRule } from "../domain/alerts.js";
import type {
  CompositeAlertExpression,
  CompositeAlertPreview,
  CompositeAlertRule,
  CreateCompositeAlertRuleInput,
} from "../domain/composite-alerts.js";
import type {
  InventoryCheckReport,
  InventoryHolderRankResult,
  InventoryWatch,
  LatestInventoryQueryResult,
} from "../domain/inventory-monitor.js";
import type { CsQaqHangingQuery } from "../adapters/csqaq/types.js";
import type { PurchasePlatform, LoadedFeeTemplate } from "../domain/fee-template.js";
import type { HangingTargetBalance, PlatformExitMode, SteamExitMode, SteamPurchaseMode } from "../domain/hanging-assessment.js";
import type {
  CsQaqCaseOverviewReport,
  CsQaqHolderReport,
  CsQaqSupplyReport,
} from "../services/csqaq-intelligence-service.js";
import type { DecisionAnalysisRequest, ItemDecisionReport } from "../services/decision-analysis-service.js";
import type { DiyService } from "../services/diy-service.js";
import type { InventoryValuationSnapshot } from "../domain/inventory-valuation.js";
import type { MarketTradingContext } from "../domain/market-trading-model.js";

export interface McpMarketService {
  getPrices(marketHashName: string): Promise<Evidence<readonly SteamDtPriceEntry[]>>;
  getKline(query: KlineQuery): Promise<Evidence<readonly import("../adapters/steamdt/types.js").SteamDtKlinePoint[]>>;
  analyze(request: AnalyzeMarketRequest): Promise<MarketAnalysisReport>;
}

export interface McpDependencies {
  readonly health: () => Readonly<Record<string, unknown>>;
  readonly getMarketService: () => McpMarketService;
  readonly getMarketCompatibilityService: () => McpMarketCompatibilityService;
  readonly getAlertService: () => McpAlertService;
  readonly getInventoryService: () => McpInventoryService;
  readonly getCsQaqIntelligenceService: () => McpCsQaqIntelligenceService;
  readonly getHangingService: () => McpHangingService;
  readonly getDecisionAnalysisService: () => McpDecisionAnalysisService;
  readonly getSectorService: () => McpSectorService;
  readonly getTradeUpCatalogService: () => McpTradeUpCatalogService;
  readonly getDiyService: () => DiyService;
  readonly getFeeAssumptions: () => LoadedFeeTemplate;
}

export interface McpCsQaqIntelligenceService {
  resolveItem(search: string): Promise<unknown>;
  analyzeHolders(search: string, limit?: number): Promise<CsQaqHolderReport>;
  analyzeSupply(search: string): Promise<CsQaqSupplyReport>;
  getCaseOverview(limit?: number): Promise<CsQaqCaseOverviewReport>;
}

export interface McpHangingService {
  screen(input: CsQaqHangingQuery & {
    readonly targetBalance: HangingTargetBalance;
    readonly sourcePlatform?: PurchasePlatform;
    readonly steamPurchaseMode?: SteamPurchaseMode;
    readonly platformExitMode?: PlatformExitMode;
    readonly limit?: number;
    readonly includeNormallyExcluded?: boolean;
  }): Promise<unknown>;
  assess(input: CsQaqHangingQuery & {
    readonly targetBalance: HangingTargetBalance;
    readonly marketHashName: string;
    readonly sourcePlatform?: PurchasePlatform;
    readonly steamExitMode?: SteamExitMode;
    readonly steamPurchaseMode?: SteamPurchaseMode;
    readonly platformExitMode?: PlatformExitMode;
    readonly klinePlatform?: string;
    readonly klineType?: number;
  }): Promise<unknown>;
}

export interface McpSectorService {
  list(refresh?: boolean): Promise<unknown>;
  kline(reference: string, interval?: string): Promise<unknown>;
}

export interface McpTradeUpCatalogService {
  sync(input?: { readonly search?: string; readonly limit?: number }): Promise<unknown>;
  analyze(search: string): unknown;
}

export interface McpDecisionAnalysisService {
  analyze(request: DecisionAnalysisRequest): Promise<ItemDecisionReport>;
}

export interface McpMarketCompatibilityService {
  comparePrices(marketHashName: string): Promise<MultiSourcePriceReport>;
}

export interface McpAlertService {
  addMarketRule(input: CreateMarketAlertRuleInput): MarketAlertRule;
  listRules(enabledOnly?: boolean): readonly MarketAlertRule[];
  setRuleEnabled(id: number, enabled: boolean): boolean;
  previewCompositeRule(input: CreateCompositeAlertRuleInput): CompositeAlertPreview;
  addCompositeRule(input: CreateCompositeAlertRuleInput): CompositeAlertRule;
  listCompositeRules(enabledOnly?: boolean): readonly CompositeAlertRule[];
  setCompositeRuleEnabled(id: number, enabled: boolean): boolean;
  testWechat(): Promise<unknown>;
  runOnce(): Promise<AlertRunReport>;
}

export interface McpInventoryService {
  check(steamId: string, options?: { readonly notify?: boolean }): Promise<InventoryCheckReport>;
  addWatch(input: {
    readonly steamId: string;
    readonly label?: string;
    readonly intervalMinutes?: number;
  }): InventoryWatch;
  listWatches(): readonly InventoryWatch[];
  queryLatestInventory(input: {
    readonly steamId: string;
    readonly marketHashName?: string;
    readonly limit?: number;
  }): LatestInventoryQueryResult;
  rankHolders(input: {
    readonly marketHashName: string;
    readonly limit?: number;
  }): InventoryHolderRankResult;
  queryLatestValuation(steamId: string): InventoryValuationSnapshot | undefined;
  disableWatch(steamId: string): boolean;
  runWatchesOnce(options?: { readonly dueOnly?: boolean }): Promise<readonly InventoryCheckReport[]>;
}

const itemQueryShape = {
  marketHashName: z.string().trim().min(1).max(256).describe("Steam official marketHashName"),
};

const klineQueryShape = {
  ...itemQueryShape,
  platform: z.string().trim().min(1).max(64).default("STEAM"),
  type: z.number().int().nonnegative().max(100).default(1),
};

const contextProvenanceSchema = z.object({
  sourceType: z.enum(["user_expert", "manual_provider_observation"]),
  label: z.string().trim().min(1).max(128),
  observedAt: z.iso.datetime().optional(),
  note: z.string().trim().max(1_000).optional(),
});

const marketTradingContextSchema = z.object({
  sector: z.object({
    name: z.string().trim().min(1).max(128),
    returnPct: z.number().finite(),
    windowDays: z.number().positive().max(365),
    provenance: contextProvenanceSchema,
  }).optional(),
  effectiveCirculatingSupply: z.object({
    central: z.number().positive(),
    low: z.number().positive().optional(),
    high: z.number().positive().optional(),
    provenance: contextProvenanceSchema,
  }).optional(),
  dealerOperation: z.object({
    suitability: z.enum(["low", "medium", "high"]),
    provenance: contextProvenanceSchema,
  }).optional(),
  tradeUp: z.object({
    role: z.enum(["input", "output", "both"]),
    contractInputCount: z.number().int().min(1).max(10),
    inputItems: z.array(z.string().trim().min(1).max(256)).max(100).optional(),
    outputItems: z.array(z.object({
      name: z.string().trim().min(1).max(256),
      probability: z.number().min(0).max(1).optional(),
      referencePrice: z.number().positive().optional(),
    })).max(100).optional(),
    inputUnitPrice: z.number().positive().optional(),
    otherCost: z.number().nonnegative().optional(),
    provenance: contextProvenanceSchema,
  }).optional(),
}).optional();

const steamIdShape = {
  steamId: z.string().trim().regex(/^\d{17}$/, "SteamID must be a 17-digit SteamID64."),
};

const adapterIdSchema = z.string().trim().regex(
  /^(?:any|[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*)$/,
  "provider must be any or a stable lowercase adapter id",
);

const marketCompositeConditionSchema = z.object({
  type: z.literal("market"),
  marketHashName: z.string().trim().min(1).max(256),
  platform: z.string().trim().min(1).max(64),
  provider: adapterIdSchema.default("any"),
  metric: z.enum([
    "sell_price", "sell_count", "bidding_price", "bidding_count",
    "spread_amount", "spread_rate", "bidding_sell_count_ratio",
  ]),
  mode: z.enum(["current", "change_rate"]).default("current"),
  windowMinutes: z.number().int().min(30).max(10_080).optional(),
  operator: z.enum(["lt", "lte", "gt", "gte"]),
  threshold: z.number().finite(),
});

const inventoryCompositeConditionSchema = z.object({
  type: z.literal("inventory"),
  steamId: z.string().trim().regex(/^\d{17}$/, "SteamID must be a 17-digit SteamID64."),
  metric: z.enum([
    "added_quantity", "removed_quantity", "inventory_value",
    "composition_change_amount", "composition_change_rate", "price_coverage",
    "high_value_added_count", "high_value_removed_count",
  ]),
  marketHashName: z.string().trim().min(1).max(256).optional(),
  windowMinutes: z.number().int().min(30).max(10_080).default(30),
  operator: z.enum(["lt", "lte", "gt", "gte"]),
  threshold: z.number().finite(),
});

const compositeExpressionSchema: z.ZodType<CompositeAlertExpression> = z.lazy(() =>
  z.union([
    marketCompositeConditionSchema,
    inventoryCompositeConditionSchema,
    z.object({
      type: z.literal("all"),
      conditions: z.array(compositeExpressionSchema).min(2).max(20),
    }),
    z.object({
      type: z.literal("any"),
      conditions: z.array(compositeExpressionSchema).min(2).max(20),
    }),
  ]),
);

const compositeRuleInputSchema = {
  name: z.string().trim().min(1).max(100),
  expression: compositeExpressionSchema,
  cooldownMinutes: z.number().int().min(0).max(43_200).default(60),
  minimumConsecutiveMatches: z.number().int().min(1).max(10).default(1),
  notifyOnRecovery: z.boolean().default(false),
  maxDataSkewMinutes: z.number().int().min(1).max(1_440).default(30),
};

export function createMcpServer(dependencies: McpDependencies): McpServer {
  const server = new McpServer(
    { name: "cs2-item-agent", version: "0.8.0-alpha.1" },
    {
      instructions:
        "Use these tools for current CS2 market facts, deterministic analysis, CSQAQ monitored-coverage intelligence, hanging scenarios, public Steam inventory observations, and local DIY recommendations. For decision questions prefer analyze_item_decision; for hanging questions first screen_hanging_candidates, then assess_hanging_candidate. DIY provider fields are facts, while visual tags and scores are local heuristics. A DIY image is a real game render only when render_diy_preview returns mode=steamdt_game_render; inspect_code_only means the Agent must return the inspect code and must not present a generic overlay as an attached result. Feedback must come from the user. Always preserve source, observedAt, confidence, fee assumptions, coverage, and limitations. CSQAQ holder rankings are monitored-sample coverage, never all-network. Private, unavailable, rate-limited, or failed inventory requests are unknown, never empty. Inventory disappearance does not prove a sale. Seven-day outputs are scenarios, not predictions. Never claim guaranteed profit or execute trades.",
    },
  );

  server.registerTool(
    "health_check",
    {
      title: "CS2 Item Agent health",
      description: "Check the local database and registered market-adapter capabilities/configuration without revealing secrets.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => toolResult(dependencies.health()),
  );

  server.registerTool(
    "get_market_prices",
    {
      title: "Get CS2 cross-platform prices",
      description:
        "Fetch current SteamDT listing prices, visible listing counts, bids, bid counts, source time, and limitations for one exact marketHashName.",
      inputSchema: itemQueryShape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ marketHashName }) =>
      safely(async () => {
        const evidence = await dependencies.getMarketService().getPrices(marketHashName);
        return {
          source: evidence.source,
          observedAt: evidence.observedAt,
          confidence: evidence.confidence,
          limitations: evidence.limitations,
          data: evidence.data.map(stripPriceRaw),
        };
      }),
  );

  server.registerTool(
    "compare_market_prices",
    {
      title: "Compare CS2 prices across configured adapters",
      description:
        "Fetch the same exact marketHashName from every configured market adapter, retain sources independently, and report same-platform differences with timestamps, per-adapter failures, and limitations.",
      inputSchema: itemQueryShape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ marketHashName }) =>
      safely(() => dependencies.getMarketCompatibilityService().comparePrices(marketHashName)),
  );

  server.registerTool(
    "add_market_alert",
    {
      title: "Add a CS2 market alert",
      description:
        "Create a local edge-triggered market threshold rule. Zero placeholders are ignored; notifications include provider, source time, and limitations.",
      inputSchema: {
        ...itemQueryShape,
        platform: z.string().trim().min(1).max(64),
        provider: adapterIdSchema.default("any"),
        metric: z.enum(["sell_price", "sell_count", "bidding_price", "bidding_count"]),
        operator: z.enum(["lt", "lte", "gt", "gte"]),
        threshold: z.number().nonnegative(),
        cooldownMinutes: z.number().int().min(0).max(43_200).default(60),
        name: z.string().trim().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ marketHashName, platform, provider, metric, operator, threshold, cooldownMinutes, name }) =>
      safely(async () => ({
        rule: dependencies.getAlertService().addMarketRule({
          marketHashName,
          platform,
          provider,
          metric,
          operator,
          threshold,
          cooldownMinutes,
          ...(name ? { name } : {}),
        }),
      })),
  );

  server.registerTool(
    "list_alert_rules",
    {
      title: "List local CS2 alert rules",
      description: "List local alert configuration and last evaluation state without exposing API keys or webhooks.",
      inputSchema: { enabledOnly: z.boolean().default(false) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ enabledOnly }) =>
      safely(async () => ({ rules: dependencies.getAlertService().listRules(enabledOnly) })),
  );

  server.registerTool(
    "preview_composite_alert_rule",
    {
      title: "Preview a CS2 composite alert rule",
      description:
        "Validate and normalize an AND/OR rule without saving it. Always show this preview to the user and obtain confirmation before calling add_composite_alert_rule.",
      inputSchema: compositeRuleInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) => safely(async () => ({ preview: dependencies.getAlertService().previewCompositeRule(input) })),
  );

  server.registerTool(
    "add_composite_alert_rule",
    {
      title: "Add a confirmed CS2 composite alert rule",
      description:
        "Save and enable a previously previewed AND/OR market or public-inventory rule. Call only after the user confirms the normalized preview.",
      inputSchema: compositeRuleInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => safely(async () => ({ rule: dependencies.getAlertService().addCompositeRule(input) })),
  );

  server.registerTool(
    "list_composite_alert_rules",
    {
      title: "List local CS2 composite alert rules",
      description: "List normalized AND/OR rules and their last deterministic evaluation state.",
      inputSchema: { enabledOnly: z.boolean().default(false) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ enabledOnly }) => safely(async () => ({ rules: dependencies.getAlertService().listCompositeRules(enabledOnly) })),
  );

  server.registerTool(
    "set_composite_alert_rule_enabled",
    {
      title: "Enable or disable a CS2 composite alert rule",
      description: "Change scheduling state without deleting the rule, evidence, or notification history.",
      inputSchema: { id: z.number().int().positive(), enabled: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ id, enabled }) => safely(async () => ({
      id,
      enabled,
      updated: dependencies.getAlertService().setCompositeRuleEnabled(id, enabled),
    })),
  );

  server.registerTool(
    "set_alert_rule_enabled",
    {
      title: "Enable or disable a CS2 alert rule",
      description: "Change scheduling state without deleting the rule or its evaluation and delivery history.",
      inputSchema: { id: z.number().int().positive(), enabled: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ id, enabled }) =>
      safely(async () => ({ id, enabled, updated: dependencies.getAlertService().setRuleEnabled(id, enabled) })),
  );

  server.registerTool(
    "run_alert_rules_once",
    {
      title: "Evaluate enabled CS2 alert rules once",
      description:
        "Fetch configured market providers, evaluate all enabled rules, and send Enterprise WeChat only for new threshold crossings.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () => safely(() => dependencies.getAlertService().runOnce()),
  );

  server.registerTool(
    "test_enterprise_wechat",
    {
      title: "Send an Enterprise WeChat test message",
      description:
        "Explicitly send one clearly labelled test message to the locally configured Enterprise WeChat webhook. This causes an external side effect.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () => safely(() => dependencies.getAlertService().testWechat()),
  );

  server.registerTool(
    "get_market_kline",
    {
      title: "Get CS2 item K-line summary",
      description:
        "Fetch and locally store an item K-line, returning a compact summary. The provider K-line has no real transaction volume.",
      inputSchema: klineQueryShape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ marketHashName, platform, type }) =>
      safely(async () => {
        const evidence = await dependencies
          .getMarketService()
          .getKline({ marketHashName, platform, type });
        return {
          source: evidence.source,
          observedAt: evidence.observedAt,
          confidence: evidence.confidence,
          limitations: evidence.limitations,
          data: summarizeKline(evidence.data),
        };
      }),
  );

  server.registerTool(
    "analyze_market_item",
    {
      title: "Analyze a CS2 market item",
      description:
        "Fetch current prices, item K-line, and optional broad-market K-line; calculate trend, supply-demand snapshot, volatility, drawdown, price percentile, relative strength, data quality, and a Chinese evidence report.",
      inputSchema: {
        ...klineQueryShape,
        includeBroadMarket: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ marketHashName, platform, type, includeBroadMarket }) =>
      safely(() =>
        dependencies
          .getMarketService()
          .analyze({ marketHashName, platform, type, includeBroadMarket }),
      ),
  );

  server.registerTool(
    "resolve_csqaq_item",
    {
      title: "Resolve a CS2 item to CSQAQ good_id",
      description:
        "Resolve an exact English marketHashName or an unambiguous Chinese item name to CSQAQ good_id. Ambiguous searches return safe candidate metadata instead of guessing.",
      inputSchema: { search: z.string().trim().min(1).max(256) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ search }) => safely(() => dependencies.getCsQaqIntelligenceService().resolveItem(search)),
  );

  server.registerTool(
    "get_csqaq_holder_ranking",
    {
      title: "Get CSQAQ monitored holder ranking",
      description:
        "Return a deduplicated SteamID holder ranking and Top 1/5/10 concentration for one item inside CSQAQ monitored public-account coverage. This is never an all-network ranking.",
      inputSchema: {
        ...itemQueryShape,
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ marketHashName, limit }) =>
      safely(() => dependencies.getCsQaqIntelligenceService().analyzeHolders(marketHashName, limit)),
  );

  server.registerTool(
    "get_csqaq_supply_trend",
    {
      title: "Get CSQAQ 180-day item supply trend",
      description:
        "Return provider-defined current survival quantity and 7/30/90/full-window changes. By default returns only the ten most recent points to keep Agent context compact.",
      inputSchema: {
        ...itemQueryShape,
        includeAllPoints: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ marketHashName, includeAllPoints }) =>
      safely(async () => {
        const report = await dependencies.getCsQaqIntelligenceService().analyzeSupply(marketHashName);
        return {
          item: report.item,
          summary: report.summary,
          points: includeAllPoints ? report.points : report.points.slice(-10),
          returnedPointCount: includeAllPoints ? report.points.length : Math.min(10, report.points.length),
          totalPointCount: report.points.length,
          evidence: report.evidence,
        };
      }),
  );

  server.registerTool(
    "get_case_market_overview",
    {
      title: "Get CS2 case opening and ROI overview",
      description:
        "Join CSQAQ case-opening counts and provider-calculated expected ROI by good_id. ROI is an expectation, not a guaranteed result.",
      inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ limit }) => safely(() => dependencies.getCsQaqIntelligenceService().getCaseOverview(limit)),
  );

  server.registerTool(
    "list_market_sectors",
    {
      title: "List CSQAQ market sector indices and current Steam card price",
      description: "Refresh and return CSQAQ sector indices plus the latest RMB cost per 100 USD Steam wallet face value.",
      inputSchema: { refresh: z.boolean().default(true) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ refresh }) => safely(() => dependencies.getSectorService().list(refresh)),
  );

  server.registerTool(
    "get_sector_kline",
    {
      title: "Get one CSQAQ sector K-line",
      description: "Resolve a CSQAQ sector by id, key, or Chinese name and return its provider-defined index K-line and period returns.",
      inputSchema: { reference: z.string().trim().min(1).max(128), interval: z.string().trim().min(1).max(16).default("1day") },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ reference, interval }) => safely(() => dependencies.getSectorService().kline(reference, interval)),
  );

  server.registerTool(
    "sync_tradeup_catalog",
    {
      title: "Sync local collection and trade-up relationships",
      description: "Import a bounded CSQAQ collection subset into SQLite. Use search/limit to respect provider rate limits.",
      inputSchema: { search: z.string().trim().min(1).max(128).optional(), limit: z.number().int().min(1).max(100).default(20) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ search, limit }) => safely(() => dependencies.getTradeUpCatalogService().sync({ ...(search ? { search } : {}), limit })),
  );

  server.registerTool(
    "analyze_tradeup_relationship",
    {
      title: "Analyze local collection rarity and trade-up relationship",
      description: "Return same-tier and next-tier members from the locally synced collection database. This proves relationships, not trade-up profitability.",
      inputSchema: { search: z.string().trim().min(1).max(256).describe("CSQAQ goodId or item name") },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ search }) => safely(async () => dependencies.getTradeUpCatalogService().analyze(search)),
  );

  server.registerTool(
    "show_hanging_fee_assumptions",
    {
      title: "Show active hanging fee assumptions",
      description:
        "Return the exact local fee, risk-buffer, and screening-threshold template used by hanging assessments.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => toolResult({ feeAssumptions: dependencies.getFeeAssumptions() }),
  );

  server.registerTool(
    "screen_hanging_candidates",
    {
      title: "Screen current CS2 hanging candidates",
      description:
        "Screen one explicit balance direction. The Agent must ask whether the user wants Steam balance or platform balance before calling this tool.",
      inputSchema: {
        targetBalance: z.enum(["steam", "platform"]).describe("Required user-selected destination balance"),
        sourcePlatform: z.enum(["BUFF", "YYYP"]).default("BUFF"),
        steamExitMode: z.enum(["highest_bid", "listing"]).default("highest_bid"),
        steamPurchaseMode: z.enum(["listing", "buy_order"]).default("listing"),
        platformExitMode: z.enum(["highest_bid", "listing"]).default("highest_bid"),
        minimumPrice: z.number().nonnegative().default(1),
        maximumPrice: z.number().positive().default(5_000),
        minimumTurnover: z.number().nonnegative().default(10),
        pageIndex: z.number().int().positive().default(1),
        limit: z.number().int().min(1).max(100).default(20),
        includeNormallyExcluded: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ targetBalance, sourcePlatform, steamExitMode, steamPurchaseMode, platformExitMode, minimumPrice, maximumPrice, minimumTurnover, pageIndex, limit, includeNormallyExcluded }) =>
      safely(() => dependencies.getHangingService().screen({
        targetBalance,
        sourcePlatform,
        sourcePlatforms: sourcePlatform,
        steamExit: steamExitMode,
        steamPurchase: steamPurchaseMode,
        platformExit: platformExitMode,
        steamPurchaseMode,
        platformExitMode,
        minimumPrice,
        maximumPrice,
        minimumTurnover,
        pageIndex,
        limit,
        includeNormallyExcluded,
      })),
  );

  server.registerTool(
    "assess_hanging_candidate",
    {
      title: "Assess one CS2 hanging candidate over seven days",
      description:
        "Recalculate one candidate with the active fee template and SteamDT K-line defensive/base/optimistic seven-day scenarios. The item must appear in the same CSQAQ candidate page/filter.",
      inputSchema: {
        ...itemQueryShape,
        targetBalance: z.enum(["steam", "platform"]).describe("Required user-selected destination balance"),
        sourcePlatform: z.enum(["BUFF", "YYYP"]).default("BUFF"),
        steamExitMode: z.enum(["highest_bid", "listing"]).default("highest_bid"),
        steamPurchaseMode: z.enum(["listing", "buy_order"]).default("listing"),
        platformExitMode: z.enum(["highest_bid", "listing"]).default("highest_bid"),
        minimumPrice: z.number().nonnegative().default(1),
        maximumPrice: z.number().positive().default(5_000),
        minimumTurnover: z.number().nonnegative().default(10),
        pageIndex: z.number().int().positive().default(1),
        klinePlatform: z.string().trim().min(1).max(64).default("STEAM"),
        klineType: z.number().int().nonnegative().max(100).default(1),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ marketHashName, targetBalance, sourcePlatform, steamExitMode, steamPurchaseMode, platformExitMode, minimumPrice, maximumPrice, minimumTurnover, pageIndex, klinePlatform, klineType }) =>
      safely(() => dependencies.getHangingService().assess({
        marketHashName,
        targetBalance,
        sourcePlatform,
        sourcePlatforms: sourcePlatform,
        steamExitMode,
        steamPurchaseMode,
        platformExitMode,
        steamPurchase: steamPurchaseMode,
        platformExit: platformExitMode,
        minimumPrice,
        maximumPrice,
        minimumTurnover,
        pageIndex,
        klinePlatform,
        klineType,
      })),
  );

  server.registerTool(
    "analyze_market_trading",
    {
      title: "Analyze one CS2 item with the market-trading model",
      description:
        "Run the dedicated market-trading model for trend, sector-relative strength, effective-float estimates, monitored concentration, dealer-operation annotations, and trade-up relationships. It does not assess seven-day hanging execution.",
      inputSchema: {
        ...itemQueryShape,
        platform: z.string().trim().min(1).max(64).default("STEAM"),
        klineType: z.number().int().nonnegative().max(100).default(1),
        includeBroadMarket: z.boolean().default(true),
        includeHolderCoverage: z.boolean().default(true),
        includeSupplyTrend: z.boolean().default(true),
        sectorReference: z.string().trim().min(1).max(128).optional(),
        sectorWindowDays: z.number().int().min(1).max(365).default(15),
        includeLocalTradeUp: z.boolean().default(true),
        expertContext: marketTradingContextSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ marketHashName, platform, klineType, includeBroadMarket, includeHolderCoverage, includeSupplyTrend, sectorReference, sectorWindowDays, includeLocalTradeUp, expertContext }) =>
      safely(() => dependencies.getDecisionAnalysisService().analyze({
        marketHashName,
        platform,
        klineType,
        includeBroadMarket,
        includeHolderCoverage,
        includeSupplyTrend,
        ...(sectorReference ? { sectorReference, sectorWindowDays } : {}),
        includeLocalTradeUp,
        ...(expertContext ? { expertContext: expertContext as MarketTradingContext } : {}),
      })),
  );

  server.registerTool(
    "analyze_item_decision",
    {
      title: "Build a comprehensive evidence-based CS2 item decision report",
      description:
        "Compatibility alias for the dedicated market-trading analysis. It does not assess seven-day hanging execution; prefer analyze_market_trading for new clients.",
      inputSchema: {
        ...itemQueryShape,
        platform: z.string().trim().min(1).max(64).default("STEAM"),
        klineType: z.number().int().nonnegative().max(100).default(1),
        includeBroadMarket: z.boolean().default(true),
        includeHolderCoverage: z.boolean().default(true),
        includeSupplyTrend: z.boolean().default(true),
        sectorReference: z.string().trim().min(1).max(128).optional(),
        sectorWindowDays: z.number().int().min(1).max(365).default(15),
        includeLocalTradeUp: z.boolean().default(true),
        expertContext: marketTradingContextSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ marketHashName, platform, klineType, includeBroadMarket, includeHolderCoverage, includeSupplyTrend, sectorReference, sectorWindowDays, includeLocalTradeUp, expertContext }) =>
      safely(() => dependencies.getDecisionAnalysisService().analyze({
        marketHashName,
        platform,
        klineType,
        includeBroadMarket,
        includeHolderCoverage,
        includeSupplyTrend,
        ...(sectorReference ? { sectorReference, sectorWindowDays } : {}),
        includeLocalTradeUp,
        ...(expertContext ? { expertContext: expertContext as MarketTradingContext } : {}),
      })),
  );

  server.registerTool(
    "sync_diy_catalog",
    {
      title: "Sync a real CS2 DIY catalog subset",
      description: "Import a searched, paginated subset of real CSQAQ catalog identities into the local DIY catalog. It does not prove current listing or ownership.",
      inputSchema: {
        search: z.string().trim().min(1).max(128),
        pages: z.number().int().min(1).max(20).default(1),
        pageSize: z.number().int().min(1).max(100).default(50),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ search, pages, pageSize }) => safely(() => dependencies.getDiyService().syncCatalog(search, pages, pageSize)),
  );

  server.registerTool(
    "enrich_diy_catalog",
    {
      title: "Enrich local DIY items",
      description: "Fetch real CSQAQ detail and locally cache/analyze provider images for a bounded catalog subset. Visual tags are local derived heuristics.",
      inputSchema: {
        search: z.string().trim().min(1).max(128).optional(),
        kind: z.enum(["skin", "sticker", "other"]).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ search, kind, limit }) => safely(() => dependencies.getDiyService().enrichCatalog({ ...(search ? { search } : {}), ...(kind ? { kind } : {}), limit })),
  );

  server.registerTool(
    "search_diy_catalog",
    {
      title: "Search the local CS2 DIY catalog",
      description: "Search locally imported skins and stickers, including provider facts and locally derived visual features.",
      inputSchema: {
        search: z.string().trim().min(1).max(128).optional(),
        kind: z.enum(["skin", "sticker", "other"]).optional(),
        enrichedOnly: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ search, kind, enrichedOnly, limit }) => safely(async () => ({ items: dependencies.getDiyService().searchCatalog({ ...(search ? { search } : {}), ...(kind ? { kind } : {}), enrichedOnly, limit }) })),
  );

  server.registerTool(
    "recommend_diy_loadouts",
    {
      title: "Recommend CS2 skin and sticker DIY loadouts",
      description: "Create three transparent rule-based layouts using local colors, style, budget and prior local feedback. This is an aesthetic suggestion, not a market fact.",
      inputSchema: {
        skin: z.string().trim().min(1).max(256),
        style: z.enum(["minimal", "monochrome", "black_gold", "contrast", "cyberpunk", "esports", "anime"]),
        budget: z.number().nonnegative().optional(),
        slotCount: z.number().int().min(1).max(5).default(4),
        resultCount: z.number().int().min(1).max(3).default(3),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ skin, style, budget, slotCount, resultCount }) => safely(async () => ({ recipes: dependencies.getDiyService().recommend({ skin, style, ...(budget !== undefined ? { budget } : {}), slotCount, resultCount }) })),
  );

  server.registerTool(
    "render_diy_preview",
    {
      title: "Render a local DIY 2D preview",
      description: "Generate or accept a masked CS2 inspect code, request a SteamDT/CS2 rendered screenshot, and cache the finished image locally. Provide recipeId or inspectCode.",
      inputSchema: {
        recipeId: z.number().int().positive().optional(),
        inspectCode: z.string().trim().min(10).max(20_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ recipeId, inspectCode }) => safely(() => inspectCode
      ? dependencies.getDiyService().renderInspectCode(inspectCode)
      : dependencies.getDiyService().renderPreview(recipeId ?? 0)),
  );

  server.registerTool(
    "record_diy_feedback",
    {
      title: "Record local DIY aesthetic feedback",
      description: "Store a local 1–5 rating, adoption state and optional liked/disliked tags. It only adjusts future deterministic ranking and is never uploaded.",
      inputSchema: {
        recipeId: z.number().int().positive(),
        rating: z.number().int().min(1).max(5),
        selected: z.boolean().default(false),
        likedTags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
        dislikedTags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
        comment: z.string().trim().max(500).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ recipeId, rating, selected, likedTags, dislikedTags, comment }) => safely(async () => dependencies.getDiyService().recordFeedback({ recipeId, rating, selected, likedTags, dislikedTags, ...(comment ? { comment } : {}) })),
  );

  server.registerTool(
    "get_diy_preferences",
    {
      title: "Get local DIY preference profile",
      description: "Read aggregate local aesthetic tag/style weights learned from explicit feedback. No model training or remote telemetry is involved.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => safely(async () => dependencies.getDiyService().getPreferences()),
  );

  server.registerTool(
    "check_public_inventory",
    {
      title: "Check a public CS2 Steam inventory",
      description:
        "Fetch one public SteamID's CS2 inventory, append a complete snapshot, and compare it only with the previous successful complete snapshot. Private or failed states never create removal events.",
      inputSchema: { ...steamIdShape, notify: z.boolean().default(false) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ steamId, notify }) =>
      safely(() => dependencies.getInventoryService().check(steamId, { notify })),
  );

  server.registerTool(
    "add_inventory_watch",
    {
      title: "Add a public inventory watch",
      description:
        "Add or re-enable a local public Steam inventory watch. The default interval is 30 minutes and can be changed.",
      inputSchema: {
        ...steamIdShape,
        label: z.string().trim().min(1).max(80).optional(),
        intervalMinutes: z.number().int().min(1).max(10_080).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ steamId, label, intervalMinutes }) =>
      safely(async () =>
        dependencies.getInventoryService().addWatch({
          steamId,
          ...(label ? { label } : {}),
          ...(intervalMinutes !== undefined ? { intervalMinutes } : {}),
        }),
      ),
  );

  server.registerTool(
    "query_latest_inventory",
    {
      title: "Query a latest local public inventory snapshot",
      description:
        "Read the latest successful local public-response snapshot for one SteamID, optionally filtering an exact marketHashName. This does not make a new Steam request.",
      inputSchema: {
        ...steamIdShape,
        marketHashName: z.string().trim().min(1).max(256).optional(),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ steamId, marketHashName, limit }) =>
      safely(async () =>
        dependencies.getInventoryService().queryLatestInventory({
          steamId,
          ...(marketHashName ? { marketHashName } : {}),
          limit,
        }),
      ),
  );

  server.registerTool(
    "rank_local_inventory_holders",
    {
      title: "Rank holders in locally monitored inventories",
      description:
        "Rank one exact marketHashName across each monitored SteamID's latest successful local snapshot. The result is local coverage only, never an all-network holder ranking.",
      inputSchema: {
        marketHashName: z.string().trim().min(1).max(256),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ marketHashName, limit }) =>
      safely(async () => dependencies.getInventoryService().rankHolders({ marketHashName, limit })),
  );

  server.registerTool(
    "query_latest_inventory_valuation",
    {
      title: "Query latest local BUFF inventory valuation",
      description:
        "Read the latest saved BUFF base-category valuation, price coverage, inventory-composition delta, market-price delta, and high-value-event count. Missing prices remain unknown and special float/pattern/sticker premiums are excluded.",
      inputSchema: steamIdShape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ steamId }) =>
      safely(async () => ({ steamId, valuation: dependencies.getInventoryService().queryLatestValuation(steamId) ?? null })),
  );

  server.registerTool(
    "list_inventory_watches",
    {
      title: "List local inventory watches",
      description: "List public inventory watches and their local scheduling state.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => safely(async () => ({ watches: dependencies.getInventoryService().listWatches() })),
  );

  server.registerTool(
    "disable_inventory_watch",
    {
      title: "Disable a local inventory watch",
      description: "Disable scheduling for a SteamID without deleting its historical snapshots or events.",
      inputSchema: steamIdShape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ steamId }) =>
      safely(async () => ({ steamId, disabled: dependencies.getInventoryService().disableWatch(steamId) })),
  );

  server.registerTool(
    "run_inventory_watches_once",
    {
      title: "Run enabled inventory watches once",
      description:
        "Check every enabled local inventory watch once and send Enterprise WeChat notifications only for observed changes when configured.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () => safely(async () => ({ reports: await dependencies.getInventoryService().runWatchesOnce() })),
  );

  return server;
}

function stripPriceRaw(entry: SteamDtPriceEntry): Readonly<Record<string, unknown>> {
  return {
    platform: entry.platform,
    ...(entry.platformItemId ? { platformItemId: entry.platformItemId } : {}),
    ...(entry.sellPrice !== undefined ? { sellPrice: entry.sellPrice } : {}),
    ...(entry.sellCount !== undefined ? { sellCount: entry.sellCount } : {}),
    ...(entry.biddingPrice !== undefined ? { biddingPrice: entry.biddingPrice } : {}),
    ...(entry.biddingCount !== undefined ? { biddingCount: entry.biddingCount } : {}),
    ...(entry.updateTime !== undefined ? { updateTime: entry.updateTime } : {}),
  };
}

async function safely(action: () => Promise<unknown>): Promise<ReturnType<typeof toolResult>> {
  try {
    return toolResult(await action());
  } catch (error) {
    return toolResult(toPublicError(error), true);
  }
}

function toolResult(value: unknown, isError = false): {
  content: [{ type: "text"; text: string }];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
} {
  const structuredContent = toRecord(value);
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}
