import { SteamDtClient } from "../adapters/steamdt/client.js";
import { CsQaqClient } from "../adapters/csqaq/client.js";
import { SteamInventoryClient } from "../adapters/steam-inventory/client.js";
import { WechatNotifier } from "../adapters/notifications/wechat.js";
import { readConfig, requireCsQaqApiToken, requireSteamDtApiKey } from "../config/env.js";
import { MarketService } from "../services/market-service.js";
import { InventoryMonitorService } from "../services/inventory-monitor-service.js";
import { InventoryValuationService } from "../services/inventory-valuation-service.js";
import { MarketCompatibilityService } from "../services/market-compatibility-service.js";
import { AlertService } from "../services/alert-service.js";
import { CsQaqIntelligenceService } from "../services/csqaq-intelligence-service.js";
import { HangingService } from "../services/hanging-service.js";
import { DecisionAnalysisService } from "../services/decision-analysis-service.js";
import { DiyService } from "../services/diy-service.js";
import { DiyImageService } from "../services/diy-image-service.js";
import { DiyInspectService } from "../services/diy-inspect-service.js";
import { CsSchemaClient } from "../adapters/cs-schema/client.js";
import { createBuiltInMarketAdapterRegistry } from "../adapters/market/factory.js";
import type { MarketAdapterRegistry } from "../adapters/market/registry.js";
import { loadFeeTemplate, type LoadedFeeTemplate } from "../domain/fee-template.js";
import { AppDatabase } from "../storage/database.js";
import { SectorService } from "../services/sector-service.js";
import { TradeUpCatalogService } from "../services/tradeup-catalog-service.js";
import type { McpDependencies } from "./create-server.js";

export interface McpRuntime {
  readonly dependencies: McpDependencies;
  readonly close: () => void;
}

export function createMcpRuntime(): McpRuntime {
  const config = readConfig();
  const database = new AppDatabase(config.databasePath);
  database.migrate();
  let service: MarketService | undefined;
  let inventoryService: InventoryMonitorService | undefined;
  let compatibilityService: MarketCompatibilityService | undefined;
  let alertService: AlertService | undefined;
  let csQaqIntelligenceService: CsQaqIntelligenceService | undefined;
  let hangingService: HangingService | undefined;
  let decisionAnalysisService: DecisionAnalysisService | undefined;
  let diyService: DiyService | undefined;
  let steamDtClient: SteamDtClient | undefined;
  let csQaqClient: CsQaqClient | undefined;
  let marketAdapterRegistry: MarketAdapterRegistry | undefined;
  let feeAssumptions: LoadedFeeTemplate | undefined;
  let sectorService: SectorService | undefined;
  let tradeUpCatalogService: TradeUpCatalogService | undefined;

  const getSteamDtClient = (): SteamDtClient => {
    steamDtClient ??= new SteamDtClient({
      apiKey: requireSteamDtApiKey(config),
      baseUrl: config.steamDtBaseUrl,
    });
    return steamDtClient;
  };
  const getCsQaqClient = (): CsQaqClient => {
    csQaqClient ??= new CsQaqClient({
      apiToken: requireCsQaqApiToken(config),
      baseUrl: config.csQaqBaseUrl,
    });
    return csQaqClient;
  };
  const getFeeAssumptions = (): LoadedFeeTemplate => {
    feeAssumptions ??= loadFeeTemplate(config.feeTemplatePath);
    return feeAssumptions;
  };
  const getMarketAdapterRegistry = (): MarketAdapterRegistry => {
    marketAdapterRegistry ??= createBuiltInMarketAdapterRegistry({
      ...(config.steamDtApiKey ? { steamDt: getSteamDtClient() } : {}),
      ...(config.csQaqApiToken ? { csQaq: getCsQaqClient() } : {}),
    });
    return marketAdapterRegistry;
  };

  return {
    dependencies: {
      health: () => ({
        ok: true,
        service: "cs2-item-agent",
        node: process.version,
        database: { path: config.databasePath },
        steamDt: { configured: Boolean(config.steamDtApiKey), baseUrl: config.steamDtBaseUrl },
        csqaq: { configured: Boolean(config.csQaqApiToken), baseUrl: config.csQaqBaseUrl },
        steamCommunity: { baseUrl: config.steamCommunityBaseUrl },
        steamProxy: { configured: Boolean(config.steamProxyUrl) },
        marketAdapters: getMarketAdapterRegistry().health(),
        inventory: {
          defaultIntervalMinutes: config.inventoryDefaultIntervalMinutes,
          valuationPlatform: "BUFF",
          priceCacheMinutes: config.inventoryPriceCacheMinutes,
          highValueItemCny: config.inventoryHighValueItemCny,
          largeChangeCny: config.inventoryLargeChangeCny,
          largeChangeRate: config.inventoryLargeChangeRate,
          minimumPriceCoverage: config.inventoryMinimumPriceCoverage,
        },
        alerts: { defaultIntervalMinutes: config.alertDefaultIntervalMinutes },
        wechat: { configured: Boolean(config.wechatWebhookUrl) },
        fees: { source: config.feeTemplatePath ? "local_file" : "built_in_default" },
      }),
      getMarketService: () => {
        service ??= new MarketService(
          getSteamDtClient(),
          database,
        );
        return service;
      },
      getMarketCompatibilityService: () => {
        compatibilityService ??= new MarketCompatibilityService(
          getMarketAdapterRegistry(),
          database,
        );
        return compatibilityService;
      },
      getAlertService: () => {
        if (!compatibilityService && (config.steamDtApiKey || config.csQaqApiToken)) {
          compatibilityService = new MarketCompatibilityService(
            getMarketAdapterRegistry(),
            database,
          );
        }
        alertService ??= new AlertService(compatibilityService, database, {
          ...(config.wechatWebhookUrl
            ? { notifier: new WechatNotifier({ webhookUrl: config.wechatWebhookUrl }) }
            : {}),
        });
        return alertService;
      },
      getInventoryService: () => {
        inventoryService ??= new InventoryMonitorService(
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
                    registry: getMarketAdapterRegistry(),
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
        return inventoryService;
      },
      getCsQaqIntelligenceService: () => {
        csQaqIntelligenceService ??= new CsQaqIntelligenceService(getCsQaqClient(), database);
        return csQaqIntelligenceService;
      },
      getHangingService: () => {
        hangingService ??= new HangingService(
          getCsQaqClient(),
          config.steamDtApiKey ? getSteamDtClient() : undefined,
          database,
          getFeeAssumptions(),
        );
        return hangingService;
      },
      getDecisionAnalysisService: () => {
        sectorService ??= config.csQaqApiToken ? new SectorService(getCsQaqClient(), database) : undefined;
        tradeUpCatalogService ??= config.csQaqApiToken ? new TradeUpCatalogService(getCsQaqClient(), database) : undefined;
        decisionAnalysisService ??= new DecisionAnalysisService(
          new MarketService(getSteamDtClient(), database),
          config.csQaqApiToken
            ? (csQaqIntelligenceService ??= new CsQaqIntelligenceService(getCsQaqClient(), database))
            : undefined,
          () => new Date(),
          database,
          sectorService,
          tradeUpCatalogService,
        );
        return decisionAnalysisService;
      },
      getSectorService: () => {
        sectorService ??= new SectorService(getCsQaqClient(), database);
        return sectorService;
      },
      getTradeUpCatalogService: () => {
        tradeUpCatalogService ??= new TradeUpCatalogService(getCsQaqClient(), database);
        return tradeUpCatalogService;
      },
      getDiyService: () => {
        if (!diyService) {
          const images = new DiyImageService(config.dataDir);
          diyService = new DiyService(
            getCsQaqClient(), database, images, () => new Date(), new CsSchemaClient({ ...(config.steamProxyUrl ? { proxyUrl: config.steamProxyUrl } : {}) }),
            new DiyInspectService(getSteamDtClient(), database, images),
          );
        }
        return diyService;
      },
      getFeeAssumptions,
    },
    close: () => database.close(),
  };
}
