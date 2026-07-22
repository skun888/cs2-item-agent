#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { readConfig, requireCsQaqApiToken, requireSteamDtApiKey } from "../config/env.js";
import { AppError, toPublicError } from "../core/errors.js";
import { summarizeKline } from "../domain/kline-summary.js";
import { SteamDtClient } from "../adapters/steamdt/client.js";
import { CsQaqClient } from "../adapters/csqaq/client.js";
import { SteamInventoryClient } from "../adapters/steam-inventory/client.js";
import { WechatNotifier } from "../adapters/notifications/wechat.js";
import { InventoryMonitorService } from "../services/inventory-monitor-service.js";
import { InventoryValuationService } from "../services/inventory-valuation-service.js";
import { MarketService } from "../services/market-service.js";
import { AppDatabase } from "../storage/database.js";
import { auditCsQaqPersonalPermissions } from "../services/csqaq-permission-audit.js";
import { MarketCompatibilityService } from "../services/market-compatibility-service.js";
import { AlertService } from "../services/alert-service.js";
import type { AlertOperator, AlertProvider, MarketAlertMetric } from "../domain/alerts.js";
import type { CreateCompositeAlertRuleInput } from "../domain/composite-alerts.js";
import { loadFeeTemplate, type PurchasePlatform } from "../domain/fee-template.js";
import type { HangingTargetBalance, PlatformExitMode, SteamExitMode, SteamPurchaseMode } from "../domain/hanging-assessment.js";
import { CsQaqIntelligenceService } from "../services/csqaq-intelligence-service.js";
import { HangingService } from "../services/hanging-service.js";
import { DecisionAnalysisService } from "../services/decision-analysis-service.js";
import type { MarketTradingContext } from "../domain/market-trading-model.js";
import { DiyService } from "../services/diy-service.js";
import { DiyImageService } from "../services/diy-image-service.js";
import { DIY_STYLES, type DiyCatalogKind, type DiyStyle } from "../domain/diy.js";
import { DiyInspectService } from "../services/diy-inspect-service.js";
import { CsSchemaClient } from "../adapters/cs-schema/client.js";
import { createBuiltInMarketAdapterRegistry } from "../adapters/market/factory.js";
import type { MarketAdapterRegistry } from "../adapters/market/registry.js";
import { SectorService } from "../services/sector-service.js";
import { TradeUpCatalogService } from "../services/tradeup-catalog-service.js";

const HELP = `CS2 Item Agent CLI

Usage:
  cs2-item-agent health
  cs2-item-agent provider list
  cs2-item-agent provider audit csqaq
  cs2-item-agent db migrate
  cs2-item-agent market price <marketHashName>
  cs2-item-agent market compare <marketHashName>
  cs2-item-agent market kline <marketHashName> --platform <name> --type <integer>
  cs2-item-agent market analyze <marketHashName> --platform <name> --type <integer> [--no-broad]
  cs2-item-agent market trade <marketHashName> [--sector <id|key|name>] [--sector-window <days>] [--platform <name>] [--type <integer>] [--context-file <json>] [--no-broad] [--no-holders] [--no-supply]
  cs2-item-agent market decide <marketHashName> [...same options]  # compatibility alias
  cs2-item-agent csqaq holders <marketHashName> [--limit <count>]
  cs2-item-agent csqaq supply <marketHashName>
  cs2-item-agent csqaq cases [--limit <count>]
  cs2-item-agent sector list
  cs2-item-agent sector kline <id|key|name> [--interval 1day]
  cs2-item-agent collection sync [--search <name>] [--limit <count>]
  cs2-item-agent collection analyze <goodId|itemName>
  cs2-item-agent fees show
  cs2-item-agent hanging screen --target steam|platform [--source BUFF|YYYP] [--steam-exit highest_bid|listing] [--steam-buy listing|buy_order] [--platform-exit highest_bid|listing] [--min-price <n>] [--max-price <n>] [--turnover <n>] [--limit <n>]
  cs2-item-agent hanging assess <marketHashName> --target steam|platform [same route options] [--platform <klinePlatform>] [--type <integer>]
  cs2-item-agent diy catalog sync <search> [--pages <1-20>] [--page-size <1-100>]
  cs2-item-agent diy catalog enrich [search] [--kind skin|sticker|other] [--limit <count>]
  cs2-item-agent diy catalog list [search] [--kind skin|sticker|other] [--enriched] [--limit <count>]
  cs2-item-agent diy recommend <skin> --style <style> [--budget <CNY>] [--slots <1-5>] [--count <1-3>]
  cs2-item-agent diy preview <recipeId>
  cs2-item-agent diy inspect <csgo_econ_action_preview code>
  cs2-item-agent diy decode <csgo_econ_action_preview code>
  cs2-item-agent diy feedback <recipeId> --rating <1-5> [--selected] [--liked <tag,tag>] [--disliked <tag,tag>] [--comment <text>]
  cs2-item-agent diy preferences
  cs2-item-agent inventory check <steamId> [--notify]
  cs2-item-agent inventory show <steamId> [--item <marketHashName>] [--limit <count>]
  cs2-item-agent inventory valuation <steamId>
  cs2-item-agent inventory holders <marketHashName> [--limit <count>]
  cs2-item-agent inventory watch add <steamId> [--label <name>] [--interval <minutes>]
  cs2-item-agent inventory watch list
  cs2-item-agent inventory watch disable <steamId>
  cs2-item-agent inventory watch run [--once]
  cs2-item-agent alert test wechat
  cs2-item-agent alert rule add <marketHashName> --platform <name> --metric <metric> --operator <op> --threshold <number> [--provider any|adapter-id] [--cooldown <minutes>] [--name <label>]
  cs2-item-agent alert rule list [--enabled]
  cs2-item-agent alert rule enable <id>
  cs2-item-agent alert rule disable <id>
  cs2-item-agent alert combo preview --file <rule.json>
  cs2-item-agent alert combo add --file <rule.json>
  cs2-item-agent alert combo list [--enabled]
  cs2-item-agent alert combo enable <id>
  cs2-item-agent alert combo disable <id>
  cs2-item-agent alert run [--once]

Examples:
  npm run dev -- health
  npm run dev -- market price "Danger Zone Case"
  npm run dev -- inventory check 7656119XXXXXXXXXX
`;

async function main(args: readonly string[]): Promise<void> {
  const config = readConfig();
  const [scope, action, ...rest] = args;

  if (!scope || scope === "help" || scope === "--help" || scope === "-h") {
    process.stdout.write(HELP);
    return;
  }

  if (scope === "health") {
    const database = new AppDatabase(config.databasePath);
    const migrations = database.migrate();
    database.close();
    printJson({
      ok: true,
      service: "cs2-item-agent",
      node: process.version,
      database: { path: config.databasePath, migrated: migrations },
      steamDt: { configured: Boolean(config.steamDtApiKey), baseUrl: config.steamDtBaseUrl },
      csqaq: { configured: Boolean(config.csQaqApiToken), baseUrl: config.csQaqBaseUrl },
      marketAdapters: createCliMarketAdapterRegistry(config).health(),
      alerts: { defaultIntervalMinutes: config.alertDefaultIntervalMinutes },
      inventory: {
        priceCacheMinutes: config.inventoryPriceCacheMinutes,
        highValueItemCny: config.inventoryHighValueItemCny,
        largeChangeCny: config.inventoryLargeChangeCny,
        largeChangeRate: config.inventoryLargeChangeRate,
        minimumPriceCoverage: config.inventoryMinimumPriceCoverage,
      },
      wechat: { configured: Boolean(config.wechatWebhookUrl) },
    });
    return;
  }

  if (scope === "provider" && action === "list") {
    printJson({ ok: true, adapters: createCliMarketAdapterRegistry(config).health() });
    return;
  }

  if (scope === "provider" && action === "audit" && rest[0] === "csqaq") {
    const client = new CsQaqClient({
      apiToken: requireCsQaqApiToken(config),
      baseUrl: config.csQaqBaseUrl,
    });
    printJson({ ok: true, report: await auditCsQaqPersonalPermissions(client) });
    return;
  }

  if (scope === "db" && action === "migrate") {
    const database = new AppDatabase(config.databasePath);
    const migrations = database.migrate();
    database.close();
    printJson({ ok: true, database: config.databasePath, appliedMigrations: migrations });
    return;
  }

  if (scope === "diy") {
    const database = new AppDatabase(config.databasePath);
    try {
      const images = new DiyImageService(config.dataDir);
      const service = new DiyService(
        new CsQaqClient({ apiToken: requireCsQaqApiToken(config), baseUrl: config.csQaqBaseUrl }),
        database,
        images,
        () => new Date(),
        new CsSchemaClient({ ...(config.steamProxyUrl ? { proxyUrl: config.steamProxyUrl } : {}) }),
        new DiyInspectService(createSteamDtClient(config), database, images),
      );
      if (action === "catalog") {
        const [catalogAction, ...catalogArgs] = rest;
        const search = positionalText(catalogArgs);
        if (catalogAction === "sync") {
          if (!search) throw new AppError("USAGE_ERROR", "DIY catalog sync requires search text.");
          printJson({ ok: true, report: await service.syncCatalog(search, parseOptionalNumber(catalogArgs, "--pages") ?? 1, parseOptionalNumber(catalogArgs, "--page-size") ?? 50) });
          return;
        }
        const kind = parseDiyKind(optionValue(catalogArgs, "--kind"));
        const limit = parseOptionalNumber(catalogArgs, "--limit") ?? (catalogAction === "enrich" ? 20 : 100);
        if (catalogAction === "enrich") {
          printJson({ ok: true, report: await service.enrichCatalog({ ...(search ? { search } : {}), ...(kind ? { kind } : {}), limit }) });
          return;
        }
        if (catalogAction === "list") {
          printJson({ ok: true, items: service.searchCatalog({ ...(search ? { search } : {}), ...(kind ? { kind } : {}), enrichedOnly: catalogArgs.includes("--enriched"), limit }) });
          return;
        }
      }
      if (action === "recommend") {
        const skin = positionalText(rest);
        const style = parseDiyStyle(optionValue(rest, "--style"));
        if (!skin || !style) throw new AppError("USAGE_ERROR", "DIY recommend requires a skin and --style.");
        printJson({ ok: true, recipes: service.recommend({ skin, style, ...optionalNumericField(rest, "--budget", "budget"), slotCount: parseOptionalNumber(rest, "--slots") ?? 4, resultCount: parseOptionalNumber(rest, "--count") ?? 3 }) });
        return;
      }
      if (action === "preview") {
        const recipeId = Number(rest[0]);
        printJson({ ok: true, recipe: await service.renderPreview(recipeId) });
        return;
      }
      if (action === "inspect") {
        const inspectCode = rest.join(" ").trim();
        if (!inspectCode) throw new AppError("USAGE_ERROR", "DIY inspect requires a csgo_econ_action_preview code.");
        printJson({ ok: true, preview: await service.renderInspectCode(inspectCode) });
        return;
      }
      if (action === "decode") {
        const inspectCode = rest.join(" ").trim();
        if (!inspectCode) throw new AppError("USAGE_ERROR", "DIY decode requires a csgo_econ_action_preview code.");
        printJson({ ok: true, decoded: service.decodeInspectCode(inspectCode) });
        return;
      }
      if (action === "feedback") {
        const recipeId = Number(rest[0]);
        const rating = parseOptionalNumber(rest, "--rating");
        if (!rating) throw new AppError("USAGE_ERROR", "DIY feedback requires --rating 1-5.");
        printJson({ ok: true, result: service.recordFeedback({
          recipeId, rating, selected: rest.includes("--selected"),
          likedTags: splitTags(optionValue(rest, "--liked")), dislikedTags: splitTags(optionValue(rest, "--disliked")),
          ...(optionValue(rest, "--comment") ? { comment: optionValue(rest, "--comment")! } : {}),
        }) });
        return;
      }
      if (action === "preferences") { printJson({ ok: true, preferences: service.getPreferences() }); return; }
      throw new AppError("USAGE_ERROR", "Unknown DIY command.");
    } finally { database.close(); }
  }

  if (scope === "market" && action === "price") {
    const marketHashName = rest.join(" ").trim();
    if (!marketHashName) throw new AppError("USAGE_ERROR", "marketHashName is required.");
    const client = createSteamDtClient(config);
    const database = new AppDatabase(config.databasePath);
    try {
      const service = new MarketService(client, database);
      const evidence = await service.getPrices(marketHashName);
      printJson({ ok: true, marketHashName, savedSnapshots: evidence.data.length, evidence });
    } finally {
      database.close();
    }
    return;
  }

  if (scope === "market" && action === "compare") {
    const marketHashName = rest.join(" ").trim();
    if (!marketHashName) throw new AppError("USAGE_ERROR", "marketHashName is required.");
    const database = new AppDatabase(config.databasePath);
    try {
      const service = new MarketCompatibilityService(
        createCliMarketAdapterRegistry(config),
        database,
      );
      printJson({ ok: true, report: await service.comparePrices(marketHashName) });
    } finally {
      database.close();
    }
    return;
  }

  if (scope === "market" && action === "kline") {
    const parsed = parseKlineArguments(rest);
    const client = createSteamDtClient(config);
    const database = new AppDatabase(config.databasePath);
    try {
      const service = new MarketService(client, database);
      const evidence = await service.getKline(parsed);
      printJson({
        ok: true,
        query: parsed,
        evidence: {
          source: evidence.source,
          observedAt: evidence.observedAt,
          confidence: evidence.confidence,
          limitations: evidence.limitations,
          data: summarizeKline(evidence.data),
        },
      });
    } finally {
      database.close();
    }
    return;
  }

  if (scope === "market" && action === "analyze") {
    const parsed = parseKlineArguments(rest);
    const client = createSteamDtClient(config);
    const database = new AppDatabase(config.databasePath);
    try {
      const service = new MarketService(client, database);
      const report = await service.analyze({
        ...parsed,
        includeBroadMarket: !rest.includes("--no-broad"),
      });
      printJson({ ok: true, report });
    } finally {
      database.close();
    }
    return;
  }

  if (scope === "market" && (action === "decide" || action === "trade")) {
    const marketHashName = positionalText(rest);
    if (!marketHashName) throw new AppError("USAGE_ERROR", "marketHashName is required.");
    const database = new AppDatabase(config.databasePath);
    try {
      const steamdt = createSteamDtClient(config);
      const csqaqClient = config.csQaqApiToken
        ? new CsQaqClient({ apiToken: config.csQaqApiToken, baseUrl: config.csQaqBaseUrl })
        : undefined;
      const csqaq = csqaqClient ? new CsQaqIntelligenceService(csqaqClient, database) : undefined;
      const sectorService = csqaqClient ? new SectorService(csqaqClient, database) : undefined;
      const tradeUpService = csqaqClient ? new TradeUpCatalogService(csqaqClient, database) : undefined;
      const type = parseOptionalNumber(rest, "--type") ?? 1;
      const service = new DecisionAnalysisService(new MarketService(steamdt, database), csqaq, () => new Date(), database, sectorService, tradeUpService);
      const expertContext = parseMarketTradingContext(rest);
      printJson({
        ok: true,
        report: await service.analyze({
          marketHashName,
          platform: optionValue(rest, "--platform") ?? "STEAM",
          klineType: type,
          includeBroadMarket: !rest.includes("--no-broad"),
          includeHolderCoverage: !rest.includes("--no-holders"),
          includeSupplyTrend: !rest.includes("--no-supply"),
          ...(optionValue(rest, "--sector") ? { sectorReference: optionValue(rest, "--sector")! } : {}),
          ...(parseOptionalNumber(rest, "--sector-window") !== undefined ? { sectorWindowDays: parseOptionalNumber(rest, "--sector-window")! } : {}),
          ...(expertContext ? { expertContext } : {}),
        }),
      });
    } finally {
      database.close();
    }
    return;
  }

  if (scope === "sector" && (action === "list" || action === "kline")) {
    const database = new AppDatabase(config.databasePath);
    try {
      const service = new SectorService(new CsQaqClient({ apiToken: requireCsQaqApiToken(config), baseUrl: config.csQaqBaseUrl }), database);
      if (action === "list") printJson({ ok: true, report: await service.list(true) });
      else {
        const reference = positionalText(rest);
        if (!reference) throw new AppError("USAGE_ERROR", "sector id, key, or name is required.");
        printJson({ ok: true, report: await service.kline(reference, optionValue(rest, "--interval") ?? "1day") });
      }
    } finally { database.close(); }
    return;
  }

  if (scope === "collection" && (action === "sync" || action === "analyze")) {
    const database = new AppDatabase(config.databasePath);
    try {
      const service = new TradeUpCatalogService(new CsQaqClient({ apiToken: requireCsQaqApiToken(config), baseUrl: config.csQaqBaseUrl }), database);
      if (action === "sync") {
        printJson({ ok: true, report: await service.sync({ ...(optionValue(rest, "--search") ? { search: optionValue(rest, "--search")! } : {}), ...(parseOptionalNumber(rest, "--limit") !== undefined ? { limit: parseOptionalNumber(rest, "--limit")! } : {}) }) });
      } else {
        const search = positionalText(rest);
        if (!search) throw new AppError("USAGE_ERROR", "goodId or item name is required.");
        printJson({ ok: true, relationships: service.analyze(search) });
      }
    } finally { database.close(); }
    return;
  }

  if (scope === "csqaq" && (action === "holders" || action === "supply" || action === "cases")) {
    const database = new AppDatabase(config.databasePath);
    try {
      const service = new CsQaqIntelligenceService(
        new CsQaqClient({
          apiToken: requireCsQaqApiToken(config),
          baseUrl: config.csQaqBaseUrl,
        }),
        database,
      );
      const limit = parseOptionalNumber(rest, "--limit");
      if (action === "cases") {
        printJson({ ok: true, report: await service.getCaseOverview(limit ?? 50) });
        return;
      }
      const marketHashName = positionalText(rest);
      if (!marketHashName) throw new AppError("USAGE_ERROR", "marketHashName is required.");
      printJson({
        ok: true,
        report: action === "holders"
          ? await service.analyzeHolders(marketHashName, limit ?? 20)
          : await service.analyzeSupply(marketHashName),
      });
    } finally {
      database.close();
    }
    return;
  }

  if (scope === "fees" && action === "show") {
    printJson({ ok: true, feeAssumptions: loadFeeTemplate(config.feeTemplatePath) });
    return;
  }

  if (scope === "hanging" && (action === "screen" || action === "assess")) {
    const database = new AppDatabase(config.databasePath);
    try {
      const targetBalance = parseTargetBalance(optionValue(rest, "--target"));
      const sourcePlatform = parsePurchasePlatform(optionValue(rest, "--source") ?? "BUFF");
      const steamExitMode = parseSteamExitMode(optionValue(rest, "--steam-exit") ?? optionValue(rest, "--exit") ?? "highest_bid");
      const steamPurchaseMode = parseSteamPurchaseMode(optionValue(rest, "--steam-buy") ?? "listing");
      const platformExitMode = parsePlatformExitMode(optionValue(rest, "--platform-exit") ?? "highest_bid");
      const query = {
        targetBalance,
        sourcePlatform,
        sourcePlatforms: sourcePlatform,
        steamExit: steamExitMode,
        steamPurchase: steamPurchaseMode,
        platformExit: platformExitMode,
        steamPurchaseMode,
        platformExitMode,
        ...optionalNumericField(rest, "--min-price", "minimumPrice"),
        ...optionalNumericField(rest, "--max-price", "maximumPrice"),
        ...optionalNumericField(rest, "--turnover", "minimumTurnover"),
        ...optionalNumericField(rest, "--page", "pageIndex"),
      } as const;
      const service = new HangingService(
        new CsQaqClient({
          apiToken: requireCsQaqApiToken(config),
          baseUrl: config.csQaqBaseUrl,
        }),
        config.steamDtApiKey
          ? new SteamDtClient({ apiKey: config.steamDtApiKey, baseUrl: config.steamDtBaseUrl })
          : undefined,
        database,
        loadFeeTemplate(config.feeTemplatePath),
      );
      if (action === "screen") {
        const limit = parseOptionalNumber(rest, "--limit");
        printJson({
          ok: true,
          report: await service.screen({
            ...query,
            ...(limit ? { limit } : {}),
            includeNormallyExcluded: rest.includes("--include-excluded"),
          }),
        });
        return;
      }
      const marketHashName = positionalText(rest);
      if (!marketHashName) throw new AppError("USAGE_ERROR", "marketHashName is required.");
      const klineType = parseOptionalNumber(rest, "--type");
      printJson({
        ok: true,
        report: await service.assess({
          ...query,
          marketHashName,
          steamExitMode,
          klinePlatform: optionValue(rest, "--platform") ?? (targetBalance === "steam" ? "STEAM" : sourcePlatform),
          ...(klineType !== undefined ? { klineType } : {}),
        }),
      });
    } finally {
      database.close();
    }
    return;
  }

  if (scope === "inventory" && action === "check") {
    const steamId = rest.find((value) => !value.startsWith("--"));
    if (!steamId) throw new AppError("USAGE_ERROR", "SteamID64 is required.");
    const database = new AppDatabase(config.databasePath);
    try {
      const service = createInventoryService(config, database);
      printJson({ ok: true, report: await service.check(steamId, { notify: rest.includes("--notify") }) });
    } finally {
      database.close();
    }
    return;
  }

  if (scope === "inventory" && action === "show") {
    const steamId = rest[0];
    if (!steamId) throw new AppError("USAGE_ERROR", "SteamID64 is required.");
    const limitRaw = optionValue(rest, "--limit");
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    const marketHashName = optionValue(rest, "--item");
    const database = new AppDatabase(config.databasePath);
    try {
      const service = createInventoryService(config, database);
      printJson({
        ok: true,
        inventory: service.queryLatestInventory({
          steamId,
          ...(marketHashName ? { marketHashName } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      });
    } finally {
      database.close();
    }
    return;
  }

  if (scope === "inventory" && action === "holders") {
    const limitIndex = rest.indexOf("--limit");
    const marketHashName = rest.slice(0, limitIndex >= 0 ? limitIndex : rest.length).join(" ").trim();
    const limitRaw = optionValue(rest, "--limit");
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    if (!marketHashName) throw new AppError("USAGE_ERROR", "marketHashName is required.");
    const database = new AppDatabase(config.databasePath);
    try {
      const service = createInventoryService(config, database);
      printJson({
        ok: true,
        ranking: service.rankHolders({ marketHashName, ...(limit !== undefined ? { limit } : {}) }),
      });
    } finally {
      database.close();
    }
    return;
  }

  if (scope === "inventory" && action === "valuation") {
    const steamId = rest[0];
    if (!steamId) throw new AppError("USAGE_ERROR", "SteamID64 is required.");
    const database = new AppDatabase(config.databasePath);
    try {
      const service = createInventoryService(config, database);
      printJson({ ok: true, valuation: service.queryLatestValuation(steamId) ?? null });
    } finally {
      database.close();
    }
    return;
  }

  if (scope === "inventory" && action === "watch") {
    const [watchAction, ...watchArgs] = rest;
    const database = new AppDatabase(config.databasePath);
    const service = createInventoryService(config, database);
    try {
      if (watchAction === "add") {
        const steamId = watchArgs[0];
        if (!steamId) throw new AppError("USAGE_ERROR", "SteamID64 is required.");
        const label = optionValue(watchArgs, "--label");
        const intervalRaw = optionValue(watchArgs, "--interval");
        const intervalMinutes = intervalRaw === undefined ? undefined : Number(intervalRaw);
        if (intervalMinutes !== undefined && (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0)) {
          throw new AppError("USAGE_ERROR", "--interval must be a positive integer in minutes.");
        }
        const watch = service.addWatch({
          steamId,
          ...(label ? { label } : {}),
          ...(intervalMinutes !== undefined ? { intervalMinutes } : {}),
        });
        printJson({ ok: true, watch });
        return;
      }
      if (watchAction === "list") {
        printJson({ ok: true, watches: service.listWatches() });
        return;
      }
      if (watchAction === "disable") {
        const steamId = watchArgs[0];
        if (!steamId) throw new AppError("USAGE_ERROR", "SteamID64 is required.");
        printJson({ ok: true, steamId, disabled: service.disableWatch(steamId) });
        return;
      }
      if (watchAction === "run") {
        if (watchArgs.includes("--once")) {
          printJson({ ok: true, reports: await service.runWatchesOnce() });
          return;
        }
        await runInventoryWorker(service);
        return;
      }
      throw new AppError("USAGE_ERROR", "Unknown inventory watch action.");
    } finally {
      database.close();
    }
  }

  if (scope === "alert") {
    const database = new AppDatabase(config.databasePath);
    const service = createAlertService(config, database);
    try {
      if (action === "test" && rest[0] === "wechat") {
        printJson({ ok: true, result: await service.testWechat() });
        return;
      }
      if (action === "rule") {
        const [ruleAction, ...ruleArgs] = rest;
        if (ruleAction === "add") {
          const firstOption = ruleArgs.findIndex((value) => value.startsWith("--"));
          const marketHashName = ruleArgs
            .slice(0, firstOption < 0 ? ruleArgs.length : firstOption)
            .join(" ")
            .trim();
          const platform = optionValue(ruleArgs, "--platform");
          const metric = optionValue(ruleArgs, "--metric");
          const operator = optionValue(ruleArgs, "--operator");
          const threshold = Number(optionValue(ruleArgs, "--threshold"));
          const provider = optionValue(ruleArgs, "--provider") ?? "any";
          const cooldownRaw = optionValue(ruleArgs, "--cooldown");
          const ruleName = optionValue(ruleArgs, "--name");
          if (!marketHashName || !platform || !isMarketMetric(metric) || !isAlertOperator(operator)) {
            throw new AppError("USAGE_ERROR", "Invalid alert rule arguments. See --help.");
          }
          if (!isAlertProvider(provider)) {
            throw new AppError("USAGE_ERROR", "--provider must be any or a stable lowercase adapter id.");
          }
          printJson({
            ok: true,
            rule: service.addMarketRule({
              marketHashName,
              platform,
              metric,
              operator,
              threshold,
              provider,
              ...(cooldownRaw !== undefined ? { cooldownMinutes: Number(cooldownRaw) } : {}),
              ...(ruleName ? { name: ruleName } : {}),
            }),
          });
          return;
        }
        if (ruleAction === "list") {
          printJson({ ok: true, rules: service.listRules(ruleArgs.includes("--enabled")) });
          return;
        }
        if (ruleAction === "enable" || ruleAction === "disable") {
          const id = Number(ruleArgs[0]);
          printJson({
            ok: true,
            id,
            enabled: ruleAction === "enable",
            updated: service.setRuleEnabled(id, ruleAction === "enable"),
          });
          return;
        }
      }
      if (action === "combo") {
        const [comboAction, ...comboArgs] = rest;
        if (comboAction === "preview" || comboAction === "add") {
          const input = parseCompositeRuleInput(comboArgs);
          printJson({
            ok: true,
            ...(comboAction === "preview"
              ? { preview: service.previewCompositeRule(input) }
              : { rule: service.addCompositeRule(input) }),
          });
          return;
        }
        if (comboAction === "list") {
          printJson({ ok: true, rules: service.listCompositeRules(comboArgs.includes("--enabled")) });
          return;
        }
        if (comboAction === "enable" || comboAction === "disable") {
          const id = Number(comboArgs[0]);
          printJson({
            ok: true,
            id,
            enabled: comboAction === "enable",
            updated: service.setCompositeRuleEnabled(id, comboAction === "enable"),
          });
          return;
        }
        throw new AppError("USAGE_ERROR", "Unknown alert combo action.");
      }
      if (action === "run") {
        if (rest.includes("--once")) {
          printJson({ ok: true, report: await service.runOnce() });
          return;
        }
        await runAlertWorker(service, config.alertDefaultIntervalMinutes);
        return;
      }
      throw new AppError("USAGE_ERROR", "Unknown alert command.");
    } finally {
      database.close();
    }
  }

  throw new AppError("USAGE_ERROR", `Unknown command: ${args.join(" ")}`, { help: HELP });
}

function createInventoryService(
  config: ReturnType<typeof readConfig>,
  database: AppDatabase,
): InventoryMonitorService {
  return new InventoryMonitorService(
    new SteamInventoryClient({
      baseUrl: config.steamCommunityBaseUrl,
      ...(config.steamProxyUrl ? { proxyUrl: config.steamProxyUrl } : {}),
    }),
    database,
    {
      defaultIntervalMinutes: config.inventoryDefaultIntervalMinutes,
      ...(config.steamDtApiKey || config.csQaqApiToken
        ? {
            valuationService: new InventoryValuationService(database, {
              registry: createCliMarketAdapterRegistry(config),
              cacheTtlMs: config.inventoryPriceCacheMinutes * 60_000,
              thresholds: {
                singleItemValue: config.inventoryHighValueItemCny,
                totalChangeAmount: config.inventoryLargeChangeCny,
                totalChangeRate: config.inventoryLargeChangeRate,
                minimumPriceCoverage: config.inventoryMinimumPriceCoverage,
              },
            }),
          }
        : {}),
      ...(config.wechatWebhookUrl
        ? { notifier: new WechatNotifier({ webhookUrl: config.wechatWebhookUrl }) }
        : {}),
    },
  );
}

function createAlertService(
  config: ReturnType<typeof readConfig>,
  database: AppDatabase,
): AlertService {
  const hasProvider = Boolean(config.steamDtApiKey || config.csQaqApiToken);
  const market = hasProvider
    ? new MarketCompatibilityService(
        createCliMarketAdapterRegistry(config),
        database,
      )
    : undefined;
  return new AlertService(market, database, {
    ...(config.wechatWebhookUrl
      ? { notifier: new WechatNotifier({ webhookUrl: config.wechatWebhookUrl }) }
      : {}),
  });
}

async function runInventoryWorker(service: InventoryMonitorService): Promise<void> {
  let stopping = false;
  process.once("SIGINT", () => {
    stopping = true;
  });
  process.once("SIGTERM", () => {
    stopping = true;
  });
  process.stderr.write("Inventory worker started. Press Ctrl+C to stop.\n");
  while (!stopping) {
    const reports = await service.runWatchesOnce({ dueOnly: true });
    for (const report of reports) printJson({ ok: true, report });
    if (!stopping) await delay(30_000);
  }
}

async function runAlertWorker(service: AlertService, intervalMinutes: number): Promise<void> {
  let stopping = false;
  process.once("SIGINT", () => {
    stopping = true;
  });
  process.once("SIGTERM", () => {
    stopping = true;
  });
  process.stderr.write(`Alert worker started with ${intervalMinutes}-minute interval. Press Ctrl+C to stop.\n`);
  while (!stopping) {
    printJson({ ok: true, report: await service.runOnce() });
    if (!stopping) await delay(intervalMinutes * 60_000);
  }
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseCompositeRuleInput(args: readonly string[]): CreateCompositeAlertRuleInput {
  const file = optionValue(args, "--file");
  const inline = optionValue(args, "--json");
  if (Boolean(file) === Boolean(inline)) {
    throw new AppError("USAGE_ERROR", "Provide exactly one of --file <rule.json> or --json <json>.");
  }
  try {
    const raw = file ? readFileSync(file, "utf8") : inline!;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("The rule JSON root must be an object.");
    }
    return parsed as CreateCompositeAlertRuleInput;
  } catch (error) {
    throw new AppError("USAGE_ERROR", `Cannot read composite rule JSON: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function parseMarketTradingContext(args: readonly string[]): MarketTradingContext | undefined {
  const file = optionValue(args, "--context-file");
  if (!file) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("The context JSON root must be an object.");
    }
    return parsed as MarketTradingContext;
  } catch (error) {
    throw new AppError("USAGE_ERROR", `Cannot read market context JSON: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function positionalText(args: readonly string[]): string {
  const firstOption = args.findIndex((value) => value.startsWith("--"));
  return args.slice(0, firstOption < 0 ? args.length : firstOption).join(" ").trim();
}

function parseOptionalNumber(args: readonly string[], name: string): number | undefined {
  const raw = optionValue(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new AppError("USAGE_ERROR", `${name} must be numeric.`);
  return value;
}

function optionalNumericField<K extends string>(
  args: readonly string[],
  option: string,
  key: K,
): Partial<Record<K, number>> {
  const value = parseOptionalNumber(args, option);
  return value === undefined ? {} : ({ [key]: value } as Record<K, number>);
}

function parsePurchasePlatform(value: string): PurchasePlatform {
  const normalized = value.toUpperCase();
  if (normalized !== "BUFF" && normalized !== "YYYP") {
    throw new AppError("USAGE_ERROR", "--source must be BUFF or YYYP.");
  }
  return normalized;
}

function parseSteamExitMode(value: string): SteamExitMode {
  if (value !== "highest_bid" && value !== "listing") {
    throw new AppError("USAGE_ERROR", "--exit must be highest_bid or listing.");
  }
  return value;
}

function parseTargetBalance(value: string | undefined): HangingTargetBalance {
  if (value === "steam" || value === "platform") return value;
  throw new AppError("USAGE_ERROR", "--target is required and must be steam or platform. Ask the user which balance they want before screening.");
}

function parseSteamPurchaseMode(value: string): SteamPurchaseMode {
  if (value === "listing" || value === "buy_order") return value;
  throw new AppError("USAGE_ERROR", "--steam-buy must be listing or buy_order.");
}

function parsePlatformExitMode(value: string): PlatformExitMode {
  if (value === "highest_bid" || value === "listing") return value;
  throw new AppError("USAGE_ERROR", "--platform-exit must be highest_bid or listing.");
}

function parseDiyKind(value: string | undefined): DiyCatalogKind | undefined {
  if (value === undefined) return undefined;
  if (value === "skin" || value === "sticker" || value === "other") return value;
  throw new AppError("USAGE_ERROR", "--kind must be skin, sticker, or other.");
}

function parseDiyStyle(value: string | undefined): DiyStyle | undefined {
  if (value === undefined) return undefined;
  if ((DIY_STYLES as readonly string[]).includes(value)) return value as DiyStyle;
  throw new AppError("USAGE_ERROR", `--style must be one of: ${DIY_STYLES.join(", ")}.`);
}

function splitTags(value: string | undefined): readonly string[] {
  return value?.split(",").map((tag) => tag.trim()).filter(Boolean) ?? [];
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createSteamDtClient(config: ReturnType<typeof readConfig>): SteamDtClient {
  return new SteamDtClient({
    apiKey: requireSteamDtApiKey(config),
    baseUrl: config.steamDtBaseUrl,
  });
}

function createCliMarketAdapterRegistry(config: ReturnType<typeof readConfig>): MarketAdapterRegistry {
  return createBuiltInMarketAdapterRegistry({
    ...(config.steamDtApiKey
      ? { steamDt: new SteamDtClient({ apiKey: config.steamDtApiKey, baseUrl: config.steamDtBaseUrl }) }
      : {}),
    ...(config.csQaqApiToken
      ? { csQaq: new CsQaqClient({ apiToken: config.csQaqApiToken, baseUrl: config.csQaqBaseUrl }) }
      : {}),
  });
}

function parseKlineArguments(args: readonly string[]): {
  marketHashName: string;
  platform: string;
  type: number;
} {
  const platformIndex = args.indexOf("--platform");
  const typeIndex = args.indexOf("--type");
  if (platformIndex < 1 || typeIndex < 1) {
    throw new AppError(
      "USAGE_ERROR",
      "K-line requires marketHashName, --platform, and --type.",
    );
  }

  const firstOptionIndex = Math.min(platformIndex, typeIndex);
  const marketHashName = args.slice(0, firstOptionIndex).join(" ").trim();
  const platform = args[platformIndex + 1]?.trim();
  const rawType = args[typeIndex + 1];
  const type = rawType === undefined ? Number.NaN : Number(rawType);

  if (!marketHashName || !platform || !Number.isInteger(type) || type < 0) {
    throw new AppError("USAGE_ERROR", "Invalid K-line arguments.");
  }
  return { marketHashName, platform, type };
}

function isMarketMetric(value: string | undefined): value is MarketAlertMetric {
  return value === "sell_price" || value === "sell_count" || value === "bidding_price" || value === "bidding_count";
}

function isAlertOperator(value: string | undefined): value is AlertOperator {
  return value === "lt" || value === "lte" || value === "gt" || value === "gte";
}

function isAlertProvider(value: string): value is AlertProvider {
  return value === "any" || /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(value);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  printJson(toPublicError(error));
  process.exitCode = 1;
});
